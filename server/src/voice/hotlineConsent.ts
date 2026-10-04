/** Binds one finalized caller utterance to the question visible when they began speaking.
 * This is a freshness/replay guard, not a semantic consent classifier. The voice agent still
 * must interpret explicit intent; quoted text and navigation do not authorize an answer. */
export class HotlineConsent {
  private current: { turn:number; decisionId:string|null; version:number|null; transcript:string|null; consumed:boolean } | null = null;
  begin(turn:number,decisionId:string|null,version:number|null) {
    if(!Number.isSafeInteger(turn)||turn<=0||turn<=(this.current?.turn??0)) return;
    this.current={turn,decisionId,version,transcript:null,consumed:false};
  }
  finish(turn:number,text:string) { if(this.current?.turn===turn) this.current.transcript=text; }
  get pending() { return !!this.current && this.current.transcript===null; }
  consume(decisionId:string,version:number,quote:unknown) {
    const c=this.current;
    const normalize=(s:string)=>s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
    if(!c || c.consumed || c.decisionId!==decisionId || c.version!==version || !c.transcript || typeof quote!=='string' || !normalize(quote) || normalize(quote)!==normalize(c.transcript))
      throw new Error('No fresh matching caller answer for this exact question and version. Read current state. Never reuse an earlier answer; wait for the caller or clarify ambiguity.');
    c.consumed=true;
  }
}

const numbers = (text: string) => new Set((text.match(/\d+(?:\.\d+)?/g) ?? []).map(n => String(Number(n))));
// A number counts as a stated value only when it comes with a measure, a price or a dimension.
// A bare or unrelated number ("after 30 seconds") is usually a mishearing and must not block an answer.
const MEASURED = /(\$\s*)?(\d+(?:\.\d+)?)\s*(ounces?|oz|pounds?|lbs?|inch(?:es)?|in\b|feet|foot|ft|dollars?|bucks|cents?|percent|%|units?|pieces?|pcs|boxes|box|each|by\b|x\b)?/gi;
/** Values the caller stated with a unit that appear nowhere in the proposal: no offered option contains them. */
export function unofferedNumbers(callerWords: string[], proposalJson: string): string[] {
  const offered = numbers(proposalJson);
  const stated = new Set<string>();
  for (const match of callerWords.join(' . ').matchAll(MEASURED)) if (match[1] || match[3]) stated.add(String(Number(match[2])));
  return [...stated].filter(n => !offered.has(n));
}
