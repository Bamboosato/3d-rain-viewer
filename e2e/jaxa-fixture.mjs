// Synthetic SDK boundary. Product requests/adoption/Inspector/UI remain unmodified.
window.__fixtureSdk = { hold: false, pending: [] };
export const Resampling = { BILINEAR: 'bilinear' };
export class ImageCollection {
 async init() {}
 last() { return new Date('2026-11-09T01:00:00Z'); }
 async getDateAll() { return [new Date('2026-11-09T00:00:00Z'), this.last()]; }
 async getImage({date}) { return { getDate:()=>date, getDataObject:async()=>{if(window.__fixtureSdk.hold)await new Promise(resolve=>window.__fixtureSdk.pending.push(resolve));return { value: date.getUTCHours()===1?20:1, width:560,height:476,data:new Float32Array(560*476),bbox:[126,28,146,46] };} }; }
}
export class TileGenerator { constructor(options){this.tileSize=options.tileSize;} async init(){if(!window.__fixtureTerrain)throw new Error('fixture terrain unavailable');} async getDataObject(){return {data:new Float32Array(this.tileSize*this.tileSize).fill(100)};} }
export const getDataObject=async()=>{throw new Error('fixture elevation unavailable');};
export const data = { Inspector: class { constructor(data){this.data=data;} getValueByCoordinateXY(){return this.data.value;} }, stat: data=>({max:data.value,mean:data.value}) };
export const image={ createPngUint8ArrayByImageDataObject:async({width,height,data})=>{const c=document.createElement('canvas');c.width=width;c.height=height;c.getContext('2d').putImageData(new ImageData(data,width,height),0,0);const blob=await new Promise(resolve=>c.toBlob(resolve));c.width=c.height=0;return new Uint8Array(await blob.arrayBuffer());}, ColorMap:class{}, createCanvas:data=>{const canvas=document.createElement('canvas');canvas.width=560;canvas.height=476;const ctx=canvas.getContext('2d');ctx.fillStyle=data.value===20?'#faec00':'#38bdf8';ctx.fillRect(0,0,560,476);return canvas;} };
