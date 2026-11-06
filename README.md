# 3D RainScape — リアルタイム雨雲 × 3D山岳地形ビューア

**WebGPU (MapLibre GL JS)** と **View Transitions API** を活用し、日本の山岳地形（**JAXA AW3D30**）上にリアルタイム雨雲（**気象庁 高解像度降水ナウキャスト / 降水短時間予報**）および衛星確定値（**JAXA GSMaP**）を立体的に重ね合わせて可視化するWebアプリケーションです。

## 主な機能

- **WebGPU駆動 3D地形レンダリング**: JAXA Earth API (`AW3D30 DSM v3.2`) を Terrain-RGB タイルへ変換し、山岳の起伏と陰影を高フレームレートで立体描画（WebGPU未対応環境はWebGL2へ自動フォールバック）。
- **ハイブリッド雨雲タイムラプス (`TimelineBar`)**:
  - **📡 リアルタイム雨雲（気象庁ナウキャスト + 今後の雨）**: 過去2時間の実況、60分先までの高解像度降水ナウキャスト予測、および最大15時間先までの降水短時間予報をシームレスに再生・シーク可能。
  - **🛰️ 衛星確定値（JAXA GSMaP 24h）**: 地上雨量計補正済みの高精度全球降水マップ（過去24時間・1時間刻み）を再生。
- **地点インスペクター (`Inspector`)**: 地図上の任意地点をクリックすると、経緯度・標高（m）・現在フレームの降雨強度（mm/h）を即座にポップアップ表示（View Transitions API 連動）。
- **山岳エリア切り替え (`PresetNav`)**: 富士山・北アルプス・阿蘇山・丹沢山地へワンクリックで3Dフライ移動（表示／非表示トグル対応）。
- **レイヤー＆描画調整 (`LayerMenu`)**: 地形の立体感（1.0x〜3.0x）、雨雲の濃さ（0%〜100%）、背景地図（OpenStreetMap / 起伏陰影 / 航空写真）をリアルタイム切り替え。

## セットアップ & 起動方法

```bash
npm install
npm run dev
```

本番ビルド:

```bash
npm run build
npm run preview
```

## データソース・クレジット

- **JAXA Earth API for JavaScript (v2.0.1)**: AW3D30 全球数値地表モデル / GSMaP 衛星全球降水マップ
- **気象庁**: 高解像度降水ナウキャスト / 今後の雨（降水短時間予報）
- **背景地図**: OpenStreetMap contributors / 国土地理院 / Esri World Imagery
