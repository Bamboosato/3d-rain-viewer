export type RendererBackend = 'webgpu' | 'webgl2' | 'webgl';

export type BaseMapId = 'osm' | 'hillshade' | 'photo';

export type RainSourceId = 'jma-nowcast' | 'jaxa-gsmap';

export interface TimelineFrameItem {
  date: Date;
  labelJST: string;
  relativeBadge: string;
  isForecast?: boolean;
  isLatestObservation?: boolean;
  basetime?: string;
  validtime?: string;
  tileDataset?: 'hrpns' | 'rasrf';
}

export interface PresetLocation {
  id: string;
  name: string;
  region: string;
  emoji: string;
  elevation: number;
  center: [number, number]; // [lng, lat]
  zoom: number;
  pitch: number;
  bearing: number;
  description: string;
}

export interface InspectorPoint {
  lng: number;
  lat: number;
  elevation: number | null;
  precipitation: number | null;
  screenX?: number;
  screenY?: number;
}

export interface WebGPUStatus {
  backend: RendererBackend;
  webgpuAvailable: boolean;
  adapterInfo: string;
  fps: number;
}
