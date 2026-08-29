import { setTimeout as sleep } from "node:timers/promises";
import type { BrowserPageSessionPort } from "../../domain/browser-identity-ports.js";
import type { UiActionSpec, UiLocator } from "../../domain/platform-ui.js";

export class UiTargetNotFoundError extends Error {}
export class UiActionExecutionError extends Error {}

interface LocatedTarget {
  token: string;
  descriptor: string;
}

function locatorExpression(locators: readonly UiLocator[], token: string, visibleOnly: boolean): string {
  return `(() => {
    const locators = ${JSON.stringify(locators)};
    const token = ${JSON.stringify(token)};
    const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const isVisible = (el) => {
      if (!el) return false;
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && rect.width > 0 && rect.height > 0;
    };
    const accessibleName = (el) => normalize(
      el.getAttribute('aria-label') || el.getAttribute('title') || el.value || el.textContent || ''
    );
    const textMatches = (actual, expected, exact) => {
      actual = normalize(actual).toLocaleLowerCase('en-US');
      expected = normalize(expected).toLocaleLowerCase('en-US');
      return exact ? actual === expected : actual.includes(expected);
    };
    const nativeRole = (el) => {
      const tag = el.tagName.toLocaleLowerCase('en-US');
      if (tag === 'button') return 'button';
      if (tag === 'a' && el.hasAttribute('href')) return 'link';
      if (tag === 'textarea') return 'textbox';
      if (tag === 'select') return 'combobox';
      if (tag === 'input') {
        const type = (el.getAttribute('type') || 'text').toLocaleLowerCase('en-US');
        if (['button','submit','reset'].includes(type)) return 'button';
        if (['text','email','search','url','tel','password'].includes(type)) return 'textbox';
        if (type === 'checkbox') return 'checkbox';
        if (type === 'radio') return 'radio';
      }
      return '';
    };
    const candidatesFor = (locator) => {
      if (locator.kind === 'css') {
        try { return Array.from(document.querySelectorAll(locator.value)); } catch { return []; }
      }
      if (locator.kind === 'label') {
        const labels = Array.from(document.querySelectorAll('label')).filter((label) => textMatches(label.textContent, locator.value, locator.exact));
        const controls = [];
        for (const label of labels) {
          if (label.htmlFor) {
            const target = document.getElementById(label.htmlFor);
            if (target) controls.push(target);
          }
          const nested = label.querySelector('input,textarea,[contenteditable="true"],select');
          if (nested) controls.push(nested);
        }
        return controls;
      }
      const all = Array.from(document.querySelectorAll('button,a,input,textarea,select,label,[role],[contenteditable="true"],div,span'));
      if (locator.kind === 'role') {
        const expectedRole = String(locator.role || '').toLocaleLowerCase('en-US');
        return all.filter((el) => {
          const role = (el.getAttribute('role') || nativeRole(el)).toLocaleLowerCase('en-US');
          return role === expectedRole && textMatches(accessibleName(el), locator.value, locator.exact);
        });
      }
      return all.filter((el) => textMatches(accessibleName(el), locator.value, locator.exact));
    };
    // Style visibility alone is a lie on this platform: it renders stacked accessibility twins
    // of its controls, and the first style-visible match can sit UNDER the strip that actually
    // receives clicks. Among visible candidates, the one that wins the hit-test at its own
    // center is the control a person would press; the first style-visible one remains a fallback
    // for targets that legitimately fail hit-testing at rest.
    const hitTestable = (el) => {
      const rect = el.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      return hit !== null && (el === hit || el.contains(hit) || hit.contains(el));
    };
    for (let i = 0; i < locators.length; i++) {
      const locator = locators[i];
      const candidates = candidatesFor(locator);
      const pick = (el, kind) => {
        const nodeToken = el.getAttribute('data-flerdvision-node') || token;
        el.setAttribute('data-flerdvision-node', nodeToken);
        return { token: nodeToken, descriptor: kind + ':' + locator.value };
      };
      if (${visibleOnly ? "true" : "false"}) {
        const visible = candidates.filter((el) => isVisible(el));
        const winner = visible.find((el) => hitTestable(el));
        if (winner) return pick(winner, locator.kind);
        if (visible.length > 0) return pick(visible[0], locator.kind);
        continue;
      }
      for (const el of candidates) {
        return pick(el, locator.kind);
      }
    }
    return null;
  })()`;
}

function tokenFor(label: string): string {
  return `fv-${label.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 32)}-${Math.random().toString(36).slice(2, 9)}`;
}

export class BrowserDomUiDriver {
  constructor(private readonly session: BrowserPageSessionPort) {}

  async locate(locators: readonly UiLocator[], timeoutMs = 10_000, visibleOnly = true): Promise<LocatedTarget> {
    if (locators.length === 0) throw new UiTargetNotFoundError("No UI locators configured");
    const deadline = Date.now() + timeoutMs;
    const token = tokenFor("target");
    while (Date.now() <= deadline) {
      const target = await this.session.evaluate<LocatedTarget | null>(locatorExpression(locators, token, visibleOnly));
      if (target) return target;
      await sleep(100);
    }
    throw new UiTargetNotFoundError(`UI target not found within ${timeoutMs} ms: ${JSON.stringify(locators)}`);
  }

  async isPresent(locators: readonly UiLocator[], timeoutMs = 250, visibleOnly = true): Promise<boolean> {
    try {
      await this.locate(locators, timeoutMs, visibleOnly);
      return true;
    } catch (error) {
      if (error instanceof UiTargetNotFoundError) return false;
      throw error;
    }
  }

  /**
   * Click the already-located, token-pinned target.
   *
   * Prefers a trusted click through the browser input pipeline: Instagram ignores synthetic
   * events outright (isTrusted === false), so an in-page el.click() reports true while the
   * application does nothing -- on the create flow that surfaced as a dialog that never opened,
   * and on a final action it would surface as an "invoked" click with no publication, i.e. a
   * guaranteed PUBLISH_UNCERTAIN. The in-page click remains only as a fallback for session
   * fakes that do not implement clickAt.
   */
  private async dispatchClick(token: string, descriptor: string, failurePrefix: string): Promise<void> {
    const selector = `[data-flerdvision-node=${JSON.stringify(token)}]`;
    if (!this.session.clickAt) {
      // Session fakes without a trusted-click capability keep the legacy in-page click.
      const clicked = await this.session.evaluate<boolean>(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        el.click();
        return true;
      })()`);
      if (!clicked) throw new UiActionExecutionError(`${failurePrefix}: ${descriptor}`);
      return;
    }

    // A trusted click lands at coordinates, so the coordinates must be true when it lands.
    // Two real failures forced this: an info overlay absorbed clicks aimed at the button under
    // it ("passing" while the flow stood still), and a dialog still animating after upload moved
    // its Weiter button between rect-read and dispatch -- the click hit the backdrop, which
    // Instagram answers with "Beitrag verwerfen?". So before dispatching: the rect must be
    // stable across two reads, and the element under the click point must be the target itself
    // (or within it). Occlusion and movement wait bounded; persisting, they fail loudly instead
    // of clicking whatever happens to be there.
    const deadline = Date.now() + 5_000;
    let lastProblem = "target never became stable";
    for (;;) {
      const probe = await this.session.evaluate<{ x: number; y: number; occludedBy: string | null; moved: boolean } | null>(`(async () => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        el.scrollIntoView({ block: 'center', inline: 'center' });
        const first = el.getBoundingClientRect();
        if (first.width <= 0 || first.height <= 0) return null;
        await new Promise((resolve) => setTimeout(resolve, 120));
        const second = el.getBoundingClientRect();
        const moved = Math.abs(first.x - second.x) > 1 || Math.abs(first.y - second.y) > 1 ||
          Math.abs(first.width - second.width) > 1 || Math.abs(first.height - second.height) > 1;
        const x = second.x + second.width / 2, y = second.y + second.height / 2;
        const hit = document.elementFromPoint(x, y);
        const related = hit !== null && (el === hit || el.contains(hit) || hit.contains(el));
        const describe = (node) => node === null ? 'nothing' : node.tagName.toLowerCase() +
          (node.getAttribute('role') ? '[role=' + node.getAttribute('role') + ']' : '') +
          ' "' + ((node.getAttribute('aria-label') || node.textContent || '').split(String.fromCharCode(10)).join(' ').trim().slice(0, 40)) + '"';
        return { x, y, occludedBy: related ? null : describe(hit), moved };
      })()`);
      if (!probe) throw new UiActionExecutionError(`${failurePrefix}: ${descriptor}`);
      if (!probe.moved && probe.occludedBy === null) {
        await this.session.clickAt(probe.x, probe.y);
        return;
      }
      lastProblem = probe.occludedBy ? `occluded by ${probe.occludedBy}` : "still moving";
      if (Date.now() >= deadline) {
        throw new UiActionExecutionError(`Refusing to click ${descriptor}: ${lastProblem}`);
      }
    }
  }

  async clickIrreversible(locators: readonly UiLocator[], timeoutMs = 10_000): Promise<string> {
    const target = await this.locate(locators, timeoutMs, true);
    await this.dispatchClick(target.token, target.descriptor, "Final-action target disappeared before click");
    return target.descriptor;
  }

  async click(locators: readonly UiLocator[], timeoutMs?: number, forbiddenLocators: readonly UiLocator[] = []): Promise<string> {
    const target = await this.locate(locators, timeoutMs ?? 10_000, true);
    if (forbiddenLocators.length > 0) {
      try {
        const forbidden = await this.locate(forbiddenLocators, 25, true);
        if (forbidden.token === target.token) throw new UiActionExecutionError("Refusing to click the final-action boundary during prepare-only execution");
      } catch (error) {
        if (error instanceof UiActionExecutionError) throw error;
        if (!(error instanceof UiTargetNotFoundError)) throw error;
      }
    }
    await this.dispatchClick(target.token, target.descriptor, "Target disappeared before click");
    return target.descriptor;
  }

  async fill(locators: readonly UiLocator[], value: string, timeoutMs?: number): Promise<string> {
    const target = await this.locate(locators, timeoutMs ?? 10_000, true);
    const selector = `[data-flerdvision-node=${JSON.stringify(target.token)}]`;

    const kind = await this.session.evaluate<{ editable: boolean; hasValue: boolean } | null>(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      return { editable: el.isContentEditable === true, hasValue: 'value' in el };
    })()`);
    if (!kind) throw new UiActionExecutionError(`Target cannot be filled: ${target.descriptor}`);

    // A state-owning editor (Instagram's caption is a Lexical instance) ignores synthetic
    // textContent writes for the same reason the platform ignores synthetic clicks: only input
    // that flows through the browser's own pipeline updates its internal state. So editable
    // targets are focused with a trusted click and typed via Input.insertText, and the write is
    // proven by reading the text back -- a caption that only LOOKS set would otherwise surface
    // as an empty caption on a real publication.
    if (kind.editable && this.session.clickAt && this.session.insertText) {
      await this.dispatchClick(target.token, target.descriptor, "Caption target disappeared before focus");
      const focused = await this.session.evaluate<boolean>(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        return el !== null && (document.activeElement === el || el.contains(document.activeElement));
      })()`);
      if (!focused) throw new UiActionExecutionError(`Editable target did not take focus: ${target.descriptor}`);
      await this.session.insertText(value);
      const readback = await this.session.evaluate<string>(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        return el ? (el.textContent || '') : '';
      })()`);
      if (!readback.includes(value)) {
        throw new UiActionExecutionError(`Editable target did not accept the text (readback mismatch): ${target.descriptor}`);
      }
      return target.descriptor;
    }

    const changed = await this.session.evaluate<boolean>(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.focus();
      if ('value' in el) {
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) setter.call(el, ${JSON.stringify(value)}); else el.value = ${JSON.stringify(value)};
      } else if (el.isContentEditable) {
        el.textContent = ${JSON.stringify(value)};
      } else {
        return false;
      }
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: null }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    if (!changed) throw new UiActionExecutionError(`Target cannot be filled: ${target.descriptor}`);
    return target.descriptor;
  }

  async setFile(locators: readonly UiLocator[], filePath: string, timeoutMs?: number): Promise<string> {
    const target = await this.locate(locators, timeoutMs ?? 10_000, false);
    const selector = `[data-flerdvision-node=${JSON.stringify(target.token)}]`;
    await this.session.setInputFiles(selector, [filePath]);
    return target.descriptor;
  }

  async attribute(locators: readonly UiLocator[], attributeName: string, timeoutMs?: number): Promise<string | null> {
    if (!/^[a-zA-Z_:][-a-zA-Z0-9_:.]*$/.test(attributeName)) throw new UiActionExecutionError(`Unsafe attribute name: ${attributeName}`);
    const target = await this.locate(locators, timeoutMs ?? 10_000, true);
    const selector = `[data-flerdvision-node=${JSON.stringify(target.token)}]`;
    return this.session.evaluate<string | null>(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      return el ? el.getAttribute(${JSON.stringify(attributeName)}) : null;
    })()`);
  }

  async execute(action: UiActionSpec, value?: string, forbiddenClickLocators: readonly UiLocator[] = []): Promise<string | undefined> {
    if (action.action === "wait" || action.action === "assert_visible") {
      const target = await this.locate(action.locators, action.timeoutMs ?? 10_000, true);
      return target.descriptor;
    }
    if (action.action === "click") return this.click(action.locators, action.timeoutMs, forbiddenClickLocators);
    if (action.action === "fill") {
      if (value === undefined) throw new UiActionExecutionError(`Action ${action.label} requires a value`);
      return this.fill(action.locators, value, action.timeoutMs);
    }
    if (action.action === "set_file") {
      if (value === undefined) throw new UiActionExecutionError(`Action ${action.label} requires a media path`);
      return this.setFile(action.locators, value, action.timeoutMs);
    }
    throw new UiActionExecutionError(`Unsupported UI action: ${(action as UiActionSpec).action}`);
  }
}
