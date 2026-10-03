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
/** Numbers the caller said that appear nowhere in the proposal: the caller stated a value no offered option contains. */
export function unofferedNumbers(callerWords: string[], proposalJson: string): string[] {
  const offered = numbers(proposalJson);
  return [...numbers(callerWords.join(' '))].filter(n => !offered.has(n));
}
