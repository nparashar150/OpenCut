export interface ExportOptions {
  format: "mp4" | "webm" | "mov";
  resolution: {
    width: number;
    height: number;
  };
  quality: "high" | "medium" | "low";
  fps: number;
}

export const QUALITY_PRESETS = {
  high: {
    videoBitrate: "5M",
    audioBitrate: "192k",
    crf: "18",
    preset: "slow"
  },
  medium: {
    videoBitrate: "2M",
    audioBitrate: "128k",
    crf: "23",
    preset: "medium"
  },
  low: {
    videoBitrate: "1M",
    audioBitrate: "96k",
    crf: "28",
    preset: "fast"
  }
};

export const DEFAULT_EXPORT_OPTIONS: ExportOptions = {
  format: "mp4",
  resolution: {
    width: 1920,
    height: 1080
  },
  quality: "high",
  fps: 30
};

// Validate export options
export function validateExportOptions(options: ExportOptions): string | null {
  if (options.resolution.width <= 0 || options.resolution.height <= 0) {
    return "Invalid resolution";
  }
  
  if (options.fps <= 0 || options.fps > 120) {
    return "FPS must be between 1 and 120";
  }
  
  return null;
}

// Format bytes to human readable size
export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 Bytes';
  
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}