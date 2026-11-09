// Data perspectives: legacy migration, damaged state, recovery, Undo failures and payload boundaries.
import {beforeEach,afterEach,expect,it,vi} from 'vitest';
import {deflateRawSync} from 'node:zlib';
import * as storage from '../src/lib/favoritesStorage';
import * as transfer from '../src/lib/favoritesTransfer';
const loc=(id:string)=>({id,name:id,center:[139,35] as [number,number],zoom:10,pitch:60,bearing:0,elevation:1,region:'fixture',description:'fixture',emoji:'*'});
beforeEach(()=>{vi.stubGlobal('indexedDB',undefined);localStorage.clear();storage.resetFavoritesMemoryCacheForTesting();});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});
it('T19 legacy 500 items remain editable without truncation after migration/restart',async()=>{
 localStorage.setItem('rain3d_favorite_locations_v1',JSON.stringify(Array.from({length:500},(_,i)=>loc(String(i)))));
 const items=storage.loadFavoriteLocations();items[0].name='edited';expect((await storage.saveFavoriteLocations(items)).success).toBe(true);
 storage.resetFavoritesMemoryCacheForTesting();expect(storage.loadFavoriteLocations()).toHaveLength(500);expect(storage.loadFavoriteLocations()[0].name).toBe('edited');
});
it('T19 failed legacy migration preserves the original and allows a later retry',async()=>{
 const raw=JSON.stringify([loc('legacy')]);localStorage.setItem('rain3d_favorite_locations_v1',raw);
 const items=storage.loadFavoriteLocations();items[0].name='edited';
 const fail=vi.spyOn(localStorage,'setItem').mockImplementation(()=>{throw new DOMException('quota','QuotaExceededError');});
 expect((await storage.saveFavoriteLocations(items)).success).toBe(false);
 storage.resetFavoritesMemoryCacheForTesting();expect(localStorage.getItem('rain3d_favorite_locations_v1')).toBe(raw);expect(storage.loadFavoriteLocations()[0].name).toBe('legacy');
 fail.mockRestore();expect((await storage.saveFavoriteLocations(items)).success).toBe(true);
 storage.resetFavoritesMemoryCacheForTesting();expect(storage.loadFavoriteLocations()[0].name).toBe('edited');
});
it('T35 corrupt current state is blocked and available in a raw rescue copy',async()=>{
 localStorage.setItem('rain3d_favorite_atomic_state_v1','{broken');
 expect((await storage.saveFavoriteLocations([])).success).toBe(false);
 expect(storage.getFavoritesStorageWarning()).toBeTruthy();expect((await storage.readFavoritesRecoveryData()).rain3d_favorite_atomic_state_v1).toBe('{broken');
});
it('T18 undo failure preserves snapshot and permits later retry',async()=>{
 await storage.saveFavoritesAndUndoAtomic([loc('new')],[loc('old')]);
 const failure=vi.spyOn(localStorage,'setItem').mockImplementation(()=>{throw new DOMException('quota','QuotaExceededError');});
 expect((await storage.restoreFavoritesUndo()).success).toBe(false);expect((await storage.loadFavoritesUndoSnapshot())?.items[0].id).toBe('old');
 failure.mockRestore();expect((await storage.restoreFavoritesUndo()).success).toBe(true);storage.resetFavoritesMemoryCacheForTesting();expect(storage.loadFavoriteLocations()[0].id).toBe('old');expect(await storage.loadFavoritesUndoSnapshot()).toBeNull();
});
it('T35 corrupt Undo is never treated as a valid empty snapshot',async()=>{
 localStorage.setItem('rain3d_favorite_atomic_state_v1',JSON.stringify({favorites:[loc('current')],undo:{items:[{id:'broken'}],savedAt:'2026-11-09T00:00:00Z'}}));
 expect((await storage.restoreFavoritesUndo()).success).toBe(false);expect(storage.getFavoritesStorageWarning()).toBeTruthy();
});
it('T37 JSON backup roundtrip preserves coordinates, camera and name',()=>{
 const original=loc('roundtrip');expect(transfer.parseBackupJson(JSON.stringify(transfer.buildBackupFile([original])))[0]).toMatchObject({ id: original.id, name: original.name, center: original.center, zoom: original.zoom, pitch: original.pitch, bearing: original.bearing, elevation: original.elevation });
});
it('T37 sharing cancellation never starts a fallback download',async()=>{
 vi.spyOn(window, 'matchMedia').mockReturnValue({matches:true} as MediaQueryList);
 vi.stubGlobal('navigator',{canShare:()=>true,share:async()=>{throw new DOMException('cancel','AbortError');}});
 const click=vi.spyOn(HTMLAnchorElement.prototype,'click');expect(await transfer.exportFavoritesFile([loc('cancel')])).toBe('cancelled');expect(click).not.toHaveBeenCalled();
});
it('T38 file size limit accepts exact boundary and rejects the next byte',async()=>{
 const data=JSON.stringify([loc('file')]);const limit=transfer.MAX_BACKUP_FILE_BYTES;
 const exact=new File([data+' '.repeat(limit-data.length)],'fixture.json');expect((await transfer.readBackupFile(exact))).toHaveLength(1);
 await expect(transfer.readBackupFile(new File([data+' '.repeat(limit-data.length+1)],'fixture.json'))).rejects.toThrow('サイズ');
});
it('T38 oversized decompressed payload is rejected',async()=>{
 const raw=JSON.stringify([['x'.repeat(1100000),13900000,3500000,1000,60,0,0,1794182400]]);
 const payload='1z'+deflateRawSync(raw).toString('base64url');await expect(transfer.decodeFavoritesPayload(payload)).rejects.toThrow('大きすぎます');
});
it('T38 invalid item cannot disappear from an otherwise valid import',()=>{
 expect(()=>transfer.parseBackupJson(JSON.stringify([loc('good'),{id:'bad'}]))).toThrow();
});

it('T38 sync export refuses legacy overflow instead of silently exporting only 100',async()=>{
 await expect(transfer.encodeFavoritesPayload(Array.from({length:101},(_,i)=>loc(String(i))))).rejects.toThrow('上限');
});
