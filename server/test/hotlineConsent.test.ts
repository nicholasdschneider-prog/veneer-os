import {describe,it,expect} from 'vitest';
import {HotlineConsent} from '../src/voice/hotlineConsent.js';
describe('hotline caller turn fence',()=>{
 it('binds a fresh complete utterance to one question and version, once',()=>{
  const g=new HotlineConsent();g.begin(1,'a',2);g.finish(1,'I choose use draft for this question.');
  expect(()=>g.consume('b',2,'I choose use draft for this question')).toThrow();
  expect(()=>g.consume('a',3,'I choose use draft for this question')).toThrow();
  expect(()=>g.consume('a',2,'Use draft')).toThrow();
  g.consume('a',2,'I choose use draft for this question');expect(()=>g.consume('a',2,'I choose use draft for this question')).toThrow();
 });
 it('rejects recycled approval after skip or go-back and refuses unfinished speech',()=>{
  const g=new HotlineConsent();g.begin(1,'a',1);g.finish(1,'Use draft.');g.consume('a',1,'Use draft');
  g.begin(2,'b',1);g.finish(2,'Skip this question.');expect(()=>g.consume('b',1,'Use draft')).toThrow();
  g.begin(3,'c',1);expect(()=>g.consume('c',1,'Use draft')).toThrow();g.finish(2,'Use draft');expect(()=>g.consume('c',1,'Use draft')).toThrow();
  g.finish(3,'Go back to Robin.');expect(()=>g.consume('c',1,'Use draft')).toThrow();
 });
});
