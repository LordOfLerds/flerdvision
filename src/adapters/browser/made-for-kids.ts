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
    if (matches.length === 0) return false;
    matches.sort((left, right) => (left.textContent || "").length - (right.textContent || "").length);
    matches[0].scrollIntoView({ block: "center", inline: "center" });
    matches[0].setAttribute('data-flerdvision-exact', '1');
    return true;
  })()`).catch(() => false);
}

/** True when a radio carrying the declared answer reads as checked. */
export async function readMadeForKids(session: BrowserPageSessionPort, madeForKids: boolean): Promise<boolean> {
  return await session.evaluate<boolean>(`(() => {
    ${discriminatorScript(madeForKids)}
    return collect(document, []).some((element) => {
      const tag = element.tagName.toLowerCase();
      if (tag !== "tp-yt-paper-radio-button" && element.getAttribute("role") !== "radio" && !(tag === "input" && element.type === "radio")) return false;
      const text = norm(element.getAttribute("aria-label")) || norm(element.textContent) || norm(element.closest("label")?.textContent);
      if (!isAnswer(text)) return false;
      return element.getAttribute("aria-checked") === "true" || element.checked === true || element.hasAttribute("checked");
    });
  })()`).catch(() => false);
}
