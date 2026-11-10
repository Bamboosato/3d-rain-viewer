// UI/state boundaries: local thumb must win over an old parent echo; unmount
// and catalog/source replacement must not submit an obsolete debounced index.
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { TimelineBar } from '../src/components/TimelineBar';
let root:Root,host:HTMLDivElement;
const frames=[0,1,2].map(i=>({date:new Date(2026,10,10,i),labelJST:`2026-11-10 0${i}:00 JST`,relativeBadge:'',isLatestObservation:i===0,isForecast:i>0}));
const select=vi.fn(),preview=vi.fn();
function render(index:number,source:'jma-nowcast'|'jaxa-gsmap'='jma-nowcast'){
 root.render(<TimelineBar rainSource={source} frames={frames} currentIndex={index} onSelectIndex={select} onPreviewIndex={preview}
 isPlaying={false} onTogglePlay={()=>{}} playbackSpeed={1} onToggleSpeed={()=>{}} observedDateJST={frames[0].labelJST}
 displayedFrame={frames[0]} isLoading={false}/>);
}
async function input(value:number){await act(async()=>{
 const el=host.querySelector('input')!;
 Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(el,String(value));
 el.dispatchEvent(new Event('input',{bubbles:true}));
});}
beforeEach(async()=>{
 (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;vi.useFakeTimers();select.mockClear();preview.mockClear();
 host=document.createElement('div');document.body.append(host);root=createRoot(host);await act(async()=>render(0));
});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.useRealTimers();});
it('newer drag survives an older selection echo and commits only the latest index',async()=>{
 await input(2);await input(0);await act(async()=>render(2));
 expect(host.querySelector('input')!.value).toBe('0');
 await act(async()=>{await vi.advanceTimersByTimeAsync(120);});
 expect(select).toHaveBeenCalledExactlyOnceWith(0);expect(preview.mock.calls.map(c=>c[0])).toEqual([2,0]);
 expect(host.querySelector('#timeline-status-pill')!.textContent).toBe('現在');
});
it('source change drops a pending old-source selection',async()=>{
 await input(2);await act(async()=>render(0,'jaxa-gsmap'));
 await act(async()=>{await vi.advanceTimersByTimeAsync(200);});expect(select).not.toHaveBeenCalled();
});
