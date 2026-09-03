import type { BrowserPageSessionPort } from "../../domain/browser-identity-ports.js";

/**
 * YouTube's made-for-kids declaration, answered the way a person reads it.
 *
 * Studio renders the two answers as custom elements with no usable role, splits each answer
 * across the radio and its label, and decorates the visible string with punctuation the contract
 * text does not carry. Exact-name locators therefore miss on a fresh page -- a replay failed
 * exactly like that -- while the meaning is unambiguous: "nicht"/"not" is the whole
 * discriminator. Both the exploration and the replay answer through this one routine, so the
 * contract never depends on the exact rendered wording.
 */
function discriminatorScript(madeForKids: boolean): string {
  return `
    const norm = (value) => String(value || "").replace(/\\s+/g, " ").trim().toLocaleLowerCase("en-US");
    const negative = ${JSON.stringify(!madeForKids)};
    const isAnswer = (text) => {
      if (text.length === 0 || text.length > 80) return false;
      if (!text.includes("speziell für kinder") && !text.includes("made for kids")) return false;
      const isNegative = text.includes("nicht") || text.startsWith("no,") || text.includes("not made");
      return isNegative === negative;
    };
    const visible = (element) => { const style = getComputedStyle(element); const rect = element.getBoundingClientRect(); return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0; };
    // Studio nests its dialog in layers of custom elements, each with its own shadow root; the
    // option can only be reached by walking every shadow root, not just those of candidates.
    const collect = (root, out) => { for (const element of Array.from(root.querySelectorAll('*'))) { const tag = element.tagName.toLowerCase(); if (tag === 'tp-yt-paper-radio-button' || element.getAttribute('role') === 'radio' || (tag === 'input' && element.type === 'radio') || tag === 'label' || tag === 'div' || tag === 'span') out.push(element); if (element.shadowRoot) collect(element.shadowRoot, out); } return out; };
  `;
}

/** Tags the visible option carrying the declared answer with data-flerdvision-exact; false when absent. */
export async function tagMadeForKidsOption(session: BrowserPageSessionPort, madeForKids: boolean): Promise<boolean> {
  return await session.evaluate<boolean>(`(() => {
    ${discriminatorScript(madeForKids)}
    for (const previous of Array.from(document.querySelectorAll('[data-flerdvision-exact]'))) previous.removeAttribute('data-flerdvision-exact');
    const matches = collect(document, []).filter((element) => visible(element) && isAnswer(norm(element.getAttribute("aria-label")) || norm(element.textContent)));
    if (matches.length === 0) {
      // Studio renders the lower sections of the details page lazily; a page that has not been
      // scrolled may simply not contain the question yet. Scroll every scroll container to its
      // end so the next look can find it.
      for (const scroller of collect(document, []).filter((element) => element.scrollHeight > element.clientHeight + 40)) scroller.scrollTop = scroller.scrollHeight;
      window.scrollTo(0, document.body.scrollHeight);
      return false;
    }
    matches.sort((left, right) => (left.textContent || "").length - (right.textContent || "").length);
    matches[0].scrollIntoView({ block: "center", inline: "center" });
    matches[0].setAttribute('data-flerdvision-exact', '1');
    return true;
  })()`).catch(() => false);
}

/**
 * True when the declared answer is in force: a radio carrying it reads as checked, or Studio has
 * already collapsed the question into its summary sentence ("Dieses Video ist nicht als
 * „speziell für Kinder" festgelegt" / "not set as made for kids"). Studio remembers the channel's
 * last answer and shows only that sentence on later uploads -- a replay that insists on finding
 * radios there would fail on a question that is already answered correctly.
 */
export async function readMadeForKids(session: BrowserPageSessionPort, madeForKids: boolean): Promise<boolean> {
  return await session.evaluate<boolean>(`(() => {
    ${discriminatorScript(madeForKids)}
    const summary = collect(document, []).some((element) => {
      if (element.children.length > 0 || !visible(element)) return false;
      const text = norm(element.textContent);
      if (text.length === 0 || text.length > 140) return false;
      const german = text.includes("speziell für kinder") && text.includes("festgelegt");
      const english = text.includes("made for kids") && (text.includes("set as") || text.includes("is set"));
      if (!german && !english) return false;
      const isNegative = text.includes("nicht als") || text.includes("not set") || text.includes("isn't set") || text.includes("is not");
      return isNegative === negative;
    });
    if (summary) return true;
    return collect(document, []).some((element) => {
      const tag = element.tagName.toLowerCase();
      if (tag !== "tp-yt-paper-radio-button" && element.getAttribute("role") !== "radio" && !(tag === "input" && element.type === "radio")) return false;
      const text = norm(element.getAttribute("aria-label")) || norm(element.textContent) || norm(element.closest("label")?.textContent);
      if (!isAnswer(text)) return false;
      return element.getAttribute("aria-checked") === "true" || element.checked === true || element.hasAttribute("checked");
    });
  })()`).catch(() => false);
}
