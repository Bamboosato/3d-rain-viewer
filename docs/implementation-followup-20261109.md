# 第2次追加修正の実装・検証報告

実施日: 2026-11-09。対象は[第2次追加修正指示書](3d-rain-viewer-second-additional-fix-instructions-v1.0.md) RE-01～14、[第1次追加指示書](3d-rain-viewer-additional-fix-instructions-v1.0.md) ADD-01～14、および[元指示書](3d-rain-viewer-developer-fix-instructions-v1.0.md) FIX-01～14。

既存の未コミット改修を引き継いで修正した。対象HEADは `710205415f3474a01bc497b28192a127df6fb221`、ブランチは `main`。今回もローカル差分であり、コミット・push・デプロイは行っていない。着手時のファイルは `output/implementation-20261109/baseline/` に保存した。

## 1. 結果と判定範囲

RE-01～14に対する実装と正式回帰テストを追加・修正した。単体・コンポーネント・実SWハンドラーの96件が成功。production buildに対する対象E2EはChromium 7件、WebKit 7件の計14件を直列実行し、すべて成功した。最終結果は下記の機械可読証跡に記録した。

- [単体結果](../output/implementation-20261109/unit-results.json)
- [E2E結果](../output/implementation-20261109/e2e-results.json)
- [環境・ビルド・最終件数](../output/implementation-20261109/verification.json)
- [最終ソースのSHA-256](../output/implementation-20261109/source-hashes.json)
- [改訂設計メモ](design_cache_and_lifecycle_notes.md)

後述の合成fixtureとAPI境界で確認した範囲の判定である。実端末のメモリ圧迫、任意のOS強制終了、実配信データの全種類、実地図のGPU描画品質まで合格とするものではない。

## 2. テスト観点・前提

ケースの詳細化に先立ち、以下の観点を分離した。

| 観点 | 正常系 | 異常系 | 境界値 | 状態遷移 |
|---|---|---|---|---|
| 機能 | 保存・復元・取り込み・Undo、降水表示 | 保存失敗、SDK初期化失敗、再取得失敗 | 最新の空一覧、全欠測 | 起動→編集→取り込み→再起動 |
| 非機能 | 共有取得・表示優先 | 未完了API、Quota、cancel | バイト・件数・並列数・期限 | 全員cancel→再要求、停止→回復 |
| データ | 保存世代、画像と地点値の一致 | 破損Undo、無効日付、未知画像 | 100/101/500件、50/51/60文字、容量上限と次の1byte | 旧形式移行、遅延旧書込み |
| UI | 成功・欠測・部分欠落の表示 | 保存エラーと入力保持 | 地図準備前、保存commit待ち | ソース切替、旧応答到着、SW更新中の編集 |

単体ではmodule state、storage、mock、timerを初期化し、応答順を制御可能なPromiseで固定する。正式テストは実App、実ダイアログ、保存API、取得API、MapViewer、`public/sw.js`のハンドラーを呼ぶ。検証対象の選択・削除ロジックをテスト内にコピーして合格させない。

E2Eはケースごとに空のブラウザcontextから開始し、ケース内のreloadではIndexedDBとCacheStorageを維持する。`e2e/server.mjs`がproduction buildを提供し、外部JMA/SDKだけを固定fixtureへ置換する。旧SWは同じビルドのcache世代をv12へ置換してseedし、v13への実際のinstall/activateを検証する。fixtureは透明な256px PNG（有効な無降水）、全タイル404、固定日時 `20261109060000`、GSMaPの1/20 mm/hおよび後着応答ゲートを使用する。個人データ・実外部サービスは使用しない。

## 3. 修正対応表

「対応済み」は実装と記載した自動検証範囲を指す。元指示書の履歴・再レビュー時の判定を過去にさかのぼって書き換えず、本表を現在の結果とする。

| RE・優先度 | 関連ADD / FIX | 修正内容・主なファイル | 検証と状態 |
|---|---|---|---|
| RE-01 P0 | ADD-01 / FIX-03,14 | `favoritesStorage.ts`で旧101/500件・60文字名を互換読込。新規上限と区別。`favoritesTransfer.ts`で短縮・一部除外せず拒否 | S01/S02/S05、旧500件、移行失敗と再試行、境界テスト。対応済み |
| RE-02 P1 | ADD-02 / FIX-03,14 | revision付き一覧・Undo・書出日時の単一状態。最新revisionと空一覧を採用。起動復元をAppキュー先頭へ | A01/A02、R01/R02/R06、実reload。対応済み |
| RE-03 P1 | ADD-03 / FIX-03 | 追加・編集・削除・取り込み・Undoを同じAppキューへ。取り込み対象がpreviewから変われば再確認。保存中の二重操作を防止 | D01、R14、取り込み/Undo E2E、保存待ちE2E。対応済み |
| RE-04 P1 | ADD-02 / FIX-03,14 | IDB transactionまたはLS単一レコードのcommitを成功条件へ。旧LSミラーへの逐次書込み・rollbackを廃止。破損/読込失敗は上書きを止め救済JSONを提供 | S03/S04、R05/R06、破損/Undo失敗、エラーUI。対応済み |
| RE-05 P1 | ADD-04 / FIX-05 | SDK Inspectorの同期採用、loading/エラーの世代照合、MapViewer準備後に最新画像を適用。ソース・時刻のURL更新を即時化 | A03/J01、R11～13、MapViewer、後着SDK E2E。対応済み |
| RE-06 P1 | ADD-05 / FIX-02 | partialを再取得。失敗を0にしない。JMA画像寸法・既知色、GSMaP有限値を検査。欠測/部分欠落/再試行UI | A04/T10、画像異常・部分回復、無降水と欠測E2E。対応済み |
| RE-07 P1 | ADD-07 / FIX-08 | 実在日付・保存構造を検証。両ソースの保存カタログ、定期/online/前面復帰更新、同時取得共有、古さと部分失敗を表示 | S06/A05、SDK保存fallback、forecast部分失敗、offline E2E。対応済み |
| RE-08 P1 | ADD-08 / FIX-06 | 編集・保存commit・同期確認中は更新適用を禁止。初回制御でreloadしない。waiting/更新済みWorkerを通知し利用者操作で適用 | 実SW更新、入力・commit待ち・取り込みキャンセルE2E、SW message寿命テスト。対応済み |
| RE-09 P1 | ADD-09 / FIX-07,11 | OPFS初期化再試行、操作期限、immutable世代ファイル、遅延closeの隔離、永続操作キュー | S07、旧close遅延→新版保存→module再起動テスト。対応済み |
| RE-10 P1 | ADD-10 / FIX-10 | メモリ/OPFS/代替Cacheの件数とbyte、世代コピーを会計。毎書込み整理、Quota時80%整理と1回再試行、memory-only通知 | バイト境界・件数・Quota・代替失敗。対応済み |
| RE-11 P1 | ADD-11 / FIX-04,12 | `asyncLifecycle.ts`の期限/cancel、全員cancel後の再要求、listener除去、HTTP本文期限、429待機、SDK初期化再試行 | R07、共有取得・本文停止・backoff cancel・404・SDK停止テスト。対応済み |
| RE-12 P2 | ADD-12 / FIX-13 | `frameBudget.ts`で両ソース合計10件/25MiB、表示保護、同時2/背景1、表示優先・昇格。背景化で先読み中断 | フレーム会計/保護・優先キュー、Appのソース切替回帰。対応済み |
| RE-13 P1 | ADD-06,13 / 全FIX、特にFIX-01,09 | 再現14ケースを正式化。実SWのrespondWith/waitUntil、所有cache整理、production build E2Eを追加 | 96件と対象2エンジンE2E。実機固有の未検証範囲は§7 |
| RE-14 P2 | ADD-14 / 共通 | 診断allowlist・100件ring・実処理接続、memory-only通知、設計値・書出表示・検証記録を更新 | 診断の機微情報非混入、共有cancel、本報告と設計メモ。対応済み |

## 4. 再レビュー再現ケースの扱い

`output/review-20261109-followup/`の過去の再現ソース・失敗結果は保持した。正式な回帰入口は `tests/followup/`。S01～S07、A01～A05、J01、D01の14ケースに加え、失敗フレーム再試行を追加した。

- S01は旧キーが残るだけで合格せず、moduleメモリを破棄した現行loaderでも101件と編集結果が残ることを確認する。S01単独実行も成功: [単独結果](../output/implementation-20261109/isolated-S01.json)。
- S03は「最初のLS書込みは成功、2回目以降は失敗」、R05は「旧LS一覧キーへの書込みが失敗」というfixture。修正後は単一書込みでcommitが完了するため、成功返値と再起動後の新版を期待する。失敗を成功へ読み替えただけではなく、複数書込みへの依存を除去した契約を検証する。
- D01は通常保存を停止させ、その間の取り込みがDB処理を開始しないことを検証し、順に解放してUI・永続・Undoが同じ最新版となることを確認する。IDB mockには実装が利用するread/deleteも追加した。[単独結果](../output/implementation-20261109/isolated-D01.json)。
- 単独結果は保存処理修正時の結果。後続のSW・URL修正後にも全体スイートで同じケースが成功している。

## 5. T01～38の実コード検証対応

表内の略記: F=`tests/followup/`、C=`tests/cache_lifecycle.test.ts`、SW=`tests/sw_runtime.test.ts`、B=`tests/favorites_boundaries.test.ts`、SDK=`tests/sdk_lifecycle.test.ts`、IMG=`tests/weather_images.test.ts`、E=`e2e/browser_core.spec.ts`。`regression_*.test.*`も正式回帰に含める。行は観点の対応であり、それぞれ独立したE2E38件を実行したという意味ではない。

| T | 検証対象・意図 | 正式テスト・証跡 |
|---|---|---|
| 01 | 自用途の旧cacheだけ削除し代替を維持 | SW activate、E 旧→新更新 |
| 02 | メモリ消失後も永続画像を利用、背景保存を寿命へ登録 | E offline reload、SW delayed put |
| 03 | ストレージ拒否で正常ネットワーク応答を失わない | regression_storage_sw、R08/R09 |
| 04 | OPFS初期化停止から取得継続・再初期化 | F S07、C 遅延close。各API全種類の実ブラウザ停止注入は未実施 |
| 05 | 遅延旧書込みが新版を上書きしない | C immutable generation→module再起動 |
| 06 | 全失敗/非有限値を正常0にしない | regression_weather、SDK、E 全画像404 |
| 07 | 有効な無降水を欠測と区別 | E 透明PNG256pxの0.0表示 |
| 08 | 部分欠落を再取得で回復 | IMG 5/20欠落→全成功、F A04 |
| 09 | canvas/寸法/未知色の異常を扱う | IMG、regression_weather decode失敗 |
| 10 | 失敗を再選択/再試行できる | F app「T10 failed frame」、A04 |
| 11 | SDK失敗Promiseを固定せず再試行 | SDK init失敗・期限切れ後の回復 |
| 12 | 共有取得の一人cancelで他を壊さない | R07 |
| 13 | 新しい画像・時刻・地点値を一致させる | R11/R12、F A03/J01、E 20→1→0 |
| 14 | ソース変更後の旧応答・旧エラーを捨てる | R13、F A03、E SDK応答遅延→JMA切替→旧応答解放 |
| 15 | 地図準備前の変更も最新画像のみ適用 | map_lifecycle実MapViewer |
| 16 | 保存commit成功/失敗とUIを一致させる | favorites_storage、F S03/S04/A01/A02、E 拒否・reload |
| 17 | 一覧とUndoの原子性、通常保存と取り込みの直列化 | F D01、favorites_storage、E 取り込み |
| 18 | Undo成功で消費、失敗時は保持し再試行可能 | B、R02、E Undo後reload |
| 19 | 旧データ移行と失敗時保全・再起動 | F S01/S02、B 500件/移行失敗、E 空一覧reload |
| 20 | 初回SW制御・更新で同期確認を失わない | E valid payload確認→更新→キャンセル |
| 21 | 編集・保存待ちでは更新適用を禁止 | E 未保存名とIDB完了通知を保留、SW 手動適用message |
| 22 | sessionStorage拒否時のhash救済・終了時の消去 | regression_favorites_lifecycle、E cancel後reload |
| 23 | 保存カタログを通信断で再利用 | regression_weather、SDK、E offline reload |
| 24 | 予測側失敗でも実況を使い部分失敗を伝える | IMG、regression_weather N1成功/N2等失敗 |
| 25 | 空/不正/不存在日付から架空フレームを作らない | R10、F S06、regression_weather |
| 26 | 更新発火・共有・保存、選択中表示の世代を維持 | F A05、IMG共有取得、SDK、R12/R13。長時間の実配信カタログ更新は未実施 |
| 27 | SWの応答と寿命、offlineと保存例外を分離 | SW、R08/R09、E offline |
| 28 | HTTP404/500のHTMLを保存しない | SW 実fetchハンドラー |
| 29 | 件数とbyte上限、境界直後の整理 | SW 100件、C 代替Cache byte上限/次書込み。全backendでの実Quota飽和は未実施 |
| 30 | 件数上限前のQuota回復、両保存先失敗時memory-only | C Quota retry、memory-only診断 |
| 31 | 最新コピーと元の鮮度を保持 | C newest copy/revalidation、immutable世代 |
| 32 | 事前・共有中・全員cancel、完了後listener除去 | regression_storage_sw、R07、C |
| 33 | HTTP本文/SDK期限、429待機cancel、恒久4xx無再試行 | C、SDK |
| 34 | 合計フレーム予算・表示保護・表示優先 | C FrameScheduler/trimFrames。実OS/GPUメモリ値やバックグラウンド電力は未測定 |
| 35 | 入力検証・storage例外・破損Undoの保護 | favorites_storage、B、F S04 |
| 36 | 実transferで呼出元だけdetachしcacheを維持 | C structuredClone transfer→同一キー再読込 |
| 37 | JSON復元と共有cancel、同期復元 | B roundtrip/share cancel、E valid import |
| 38 | ファイルbyte境界、実解凍後上限、件数・名前境界 | B、R03/R04、F S01/S02/S05、regression_favorites_lifecycle |

## 6. 検証中に追加修正した問題

### ソース切替直後の再読み込み

再現: JMA→GSMaP→JMAを選び、0.0表示直後にreload。URL反映の300ms待機が残るとGSMaPへ戻った。Chromium/WebKitで再現した実装問題であり、以前のテストに「状態変更直後のreload」がなかった。カメラ移動だけをdebounceし、ソース・時刻・背景・誇張率を即時URL反映へ変更した。Eのソース往復ケースにreloadと旧SDK応答の解放を組み込み再発を検出する。

### 新Workerがinstalled/waitingに残る場合の更新通知

再現: 旧v12を初回制御→編集開始→v13へ配信切替→registration.update。Chromiumで断続的に、skipWaiting呼出し・完了が記録されても待機状態が15秒を超えた。旧Workerの追跡対象waitUntilは空であった。ブラウザ内部の停止理由までは断定しない。環境・タイミング依存を契機として、controllerchangeだけで通知する実装の観点不足を検出した。

waitingも通知し、編集・保存完了後の利用者クリックから有効化を再要求する経路を追加した。自動reloadは追加していない。修正後の対象ケースは[Chromium単独4回](../output/implementation-20261109/isolated-sw-update-four.json)成功。最終通し実行では診断用のSWラッパーを除去した。調査証跡は[e2e-update-skip-diagnostic.json](../output/implementation-20261109/e2e-update-skip-diagnostic.json)と[診断サーバー](../output/implementation-20261109/diagnostic-server.mjs)。更新通知とactivate後のcache整理を別々に検証する。

## 7. 実行方法・環境・未実施範囲

```powershell
npm test -- --reporter=default --reporter=json --outputFile=output/implementation-20261109/unit-results.json
npm run build
npm run test:e2e
```

Windows 11（build 26200）、Node v24.22.1、TypeScript 5.7.3、Vite 6.4.5、Vitest 5.1.0、Playwright 1.65.0。Chromium 158.0.8127.18 / revision 1254、WebKit 27.2 / revision 2388。E2Eはworkers=1、retries=0。ネットワーク/ブラウザ起動がsandbox内では拒否されたため、許可されたローカルE2Eコマンドをsandbox外で実行した。外部APIへの実アクセスはfixtureで遮断する。

`npm run build`は`tsc -b`を含み成功。Viteの500kB超chunk警告は残る（main JS約1.62MB、gzip約457kB）。これは性能最適化の追加候補であり、今回のデータ保全・競合修正の失敗ではない。`lint`もproject referencesを実検査する`tsc -b --pretty false`へ変更した。単体の一部では意図したcleanup/cancelのAbortErrorがstderrに出るが、未処理の失敗としては検出されていない。

E2E範囲は保存・実reload・同期取り込み/Undo・更新中の入力保護・無降水/欠測・offline・旧応答の破棄に絞った2エンジンのクロスブラウザ実行。これらは今回変更した状態遷移が集中し、単体mockだけではSW/永続/URLの境界を確認できないため選定した。サイト全機能E2E、Firefox、実Android/iOS/Safari、実共有シート、実地図/標高GPU品質、長時間負荷、ディスク実容量飽和、任意時点の強制終了は未実施。WebKitランナーの成功は実iPhoneでの成功を意味しない。

SDK等のAPIが物理cancelを提供しない場合は呼出元の期限と後着結果の不採用を保証する。内部SDK通信の即停止までは保証しない。フレーム予算は保持データの推定会計であり、OS/GPUの総実使用量上限ではない。複数タブからの同時お気に入り編集を分散transactionとして直列化する機能は今回追加していない。

## 8. レビュー用変更説明

旧お気に入りの切り捨て、空一覧の復元失敗、通常保存と取り込みの競合、後着画像と地点値の不一致を修正した。保存状態をrevision付き単一レコードへまとめ、UIの更新順序と永続commitを揃えた。気象データの欠測・部分失敗を明示し、カタログ更新、期限/cancel、OPFS世代保護と容量管理、表示優先のフレーム予算を実装した。

SW更新では編集・保存・同期確認を保護し、待機Workerも利用者操作で適用できる。正式回帰とproduction buildの対象E2Eを追加した。実行件数・証跡は§1、環境と未実施範囲は§7を参照する。設計メモと実装値は同時に更新した。
