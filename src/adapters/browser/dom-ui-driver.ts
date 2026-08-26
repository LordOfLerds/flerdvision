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
      return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && rect.width >= 0 && rect.height >= 0;
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
      if (tag === 'input') {
        const type = (el.getAttribute('type') || 'text').toLocaleLowerCase('en-US');
        if (['button','submit','reset'].includes(type)) return 'button';
        if (['text','email','search','url','tel','password'].includes(type)) return 'textbox';
        if (type === 'checkbox') return 'checkbox';
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
      const all = Array.from(document.querySelectorAll('button,a,input,textarea,label,[role],[contenteditable="true"],div,span'));
      if (locator.kind === 'role') {
        const expectedRole = String(locator.role || '').toLocaleLowerCase('en-US');
        return all.filter((el) => {
          const role = (el.getAttribute('role') || nativeRole(el)).toLocaleLowerCase('en-US');
          return role === expectedRole && textMatches(accessibleName(el), locator.value, locator.exact);
        });
      }
      return all.filter((el) => textMatches(accessibleName(el), locator.value, locator.exact));
    };
    for (let i = 0; i < locators.length; i++) {
      const locator = locators[i];
      const candidates = candidatesFor(locator);
      for (const el of candidates) {
        if (${visibleOnly ? "true" : "false"} && !isVisible(el)) continue;
        const nodeToken = el.getAttribute('data-flerdvision-node') || token;
        el.setAttribute('data-flerdvision-node', nodeToken);
        return { token: nodeToken, descriptor: locator.kind + ':' + locator.value };
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
    const selector = `[data-flerdvision-node=${JSON.stringify(target.token)}]`;
    const clicked = await this.session.evaluate<boolean>(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.click();
      return true;
    })()`);
    if (!clicked) throw new UiActionExecutionError(`Target disappeared before click: ${target.descriptor}`);
    return target.descriptor;
  }

  async fill(locators: readonly UiLocator[], value: string, timeoutMs?: number): Promise<string> {
    const target = await this.locate(locators, timeoutMs ?? 10_000, true);
    const selector = `[data-flerdvision-node=${JSON.stringify(target.token)}]`;
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
