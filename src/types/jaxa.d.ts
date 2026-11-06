export type Bbox = [number, number, number, number];

export declare enum Colors {
  GRAY = 'gray',
  JET = 'jet',
  NDVI = 'ndvi',
  SMC = 'smc',
  IC = 'ic',
}

export declare enum Projection {
  EPSG4326 = 'EPSG:4326',
  EPSG3857 = 'EPSG:3857',
  EPSG3995 = 'EPSG:3995',
  EPSG3031 = 'EPSG:3031',
}

export declare enum Resampling {
  NEAREST = 'NEAREST',
  BILINEAR = 'BILINEAR',
}

export interface ColorMapObject {
  min: number;
  max: number;
  colors?: Colors | string[];
  nanColor?: string;
  deleteMin?: boolean;
  deleteMax?: boolean;
  log?: boolean;
  logOrigin?: number;
  step?: number;
}

export interface ImageDataObject {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export interface DataObject {
  width: number;
  height: number;
  data: Float32Array | Uint32Array;
  bbox: Bbox;
  unit: string;
  date: Date;
  formattedDate: string;
  projection: Projection;
  src: Array<{ cog: string; stac: string }>;
  photometricInterpretation: number;
  colors?: string[];
  classes?: unknown;
}

export declare class ColorMap {
  constructor(colorMapObject: ColorMapObject | ColorMapObject[]);
  getColorMapObject(): ColorMapObject | ColorMapObject[];
  getColor(x: number): { r: number; g: number; b: number; a: number };
  getColorUint8ClampedArray(x: number): Uint8ClampedArray;
  createColorBarCanvas(width: number, height: number): HTMLCanvasElement;
  createColorBarPng(width: number, height: number): Promise<Uint8Array>;
  createColorBarImageDataObject(width: number, height: number): ImageDataObject;
  createLegendCanvas(width: number, height: number, size: number, unit: string): HTMLCanvasElement;
}

export declare class Inspector {
  constructor(dataObject: DataObject);
  getPixelByCoordinateXY(x: number, y: number): { x: number; y: number } | null;
  getCoordinateByPixelXY(x: number, y: number): { x: number; y: number; projection: Projection } | null;
  getValueByCoordinateXY(x: number, y: number): number | null;
  getValueByPixelXY(x: number, y: number): number | null;
}

export declare class Image {
  getDataObject(options: {
    bbox?: Bbox;
    width?: number;
    height?: number;
    resampling?: Resampling;
    onloading?: (progress: number, dataObject: DataObject) => void;
  }): Promise<DataObject>;
  getCachedDataObject(): DataObject;
  getCollectionUrl(): string;
  getDate(): Date;
  getFormattedDate(): string;
  getBand(): string;
}

export declare class ImageCollection {
  constructor(options: { collectionUrl: string });
  init(): Promise<void>;
  formatDate(date: Date): string;
  first(): Date;
  last(): Date;
  prev(date: Date): Promise<Date>;
  next(date: Date): Promise<Date>;
  getDateAll(start: Date, end: Date): Promise<Date[]>;
  getFormattedDateAll(start: Date, end: Date): Promise<string[]>;
  getBandIdAll(): string[];
  getImage(options?: { date?: Date; band?: string }): Promise<Image>;
}

export declare class TileGenerator {
  constructor(options: {
    collectionUrl: string;
    date?: Date;
    band?: string;
    resampling?: Resampling;
    colorMapObject?: ColorMapObject;
    tileSize?: number;
    delay?: number;
  });
  init(): Promise<void>;
  abort(): void;
  getDataObject(x: number, y: number, z: number, abortSignal?: AbortSignal): Promise<DataObject>;
  getCanvas(x: number, y: number, z: number, abortSignal?: AbortSignal): Promise<HTMLCanvasElement>;
  getOffscreenCanvas(x: number, y: number, z: number, abortSignal?: AbortSignal): Promise<OffscreenCanvas>;
  getPng(x: number, y: number, z: number, abortSignal?: AbortSignal): Promise<Uint8Array>;
  setColorMapObject(colorMapObject: ColorMapObject): void;
}

export interface JaxaEarthModule {
  Colors: typeof Colors;
  Projection: typeof Projection;
  Resampling: typeof Resampling;
  Image: typeof Image;
  ImageCollection: typeof ImageCollection;
  TileGenerator: typeof TileGenerator;
  getDataObject: (options: {
    collectionUrl: string;
    date?: Date;
    band?: string;
    bbox?: Bbox;
    width?: number;
    height?: number;
    resampling?: Resampling;
    onloading?: (progress: number, dataObject: DataObject) => void;
  }) => Promise<DataObject>;
  image: {
    ColorMap: typeof ColorMap;
    createCanvas: (dataObject: DataObject, colorMap: ColorMap) => HTMLCanvasElement;
    createImageDataObject: (dataObject: DataObject, colorMap: ColorMap) => ImageDataObject;
    createPngUint8ArrayByImageDataObject: (imageDataObject: ImageDataObject) => Promise<Uint8Array>;
    createPng: (dataObject: DataObject, colorMap: ColorMap) => Promise<Uint8Array>;
  };
  data: {
    Inspector: typeof Inspector;
    stat: (dataObject: DataObject) => {
      size: number;
      min: number;
      max: number;
      sum: number;
      mean: number;
      stdev: number;
      median: number;
    };
  };
}
