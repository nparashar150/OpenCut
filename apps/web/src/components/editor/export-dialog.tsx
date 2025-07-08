"use client";

import { useFFmpegWorker } from "@/hooks/use-ffmpeg-worker";
import { ExportOptions } from "@/lib/export-utils";
import { useMediaStore } from "@/stores/media-store";
import { useTimelineStore } from "@/stores/timeline-store";
import { AlertCircle, FileVideo, Info } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui/dialog";
import { Label } from "../ui/label";
import { Progress } from "../ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import { useEditorStore } from "@/stores/editor-store";
import { calculateTimelineDuration } from "@/lib/ffmpeg-utils";

interface ExportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const RESOLUTION_PRESETS = [
  // --- 16:9 ---
  { label: "4K (3840x2160)", width: 3840, height: 2160, aspect: "16:9", premium: true },
  { label: "1080p (1920x1080)", width: 1920, height: 1080, aspect: "16:9" },
  { label: "720p (1280x720)", width: 1280, height: 720, aspect: "16:9" },
  { label: "480p (854x480)", width: 854, height: 480, aspect: "16:9" },
  { label: "360p (640x360)", width: 640, height: 360, aspect: "16:9" },

  // --- 9:16 (Vertical) ---
  { label: "1080p Vertical (1080x1920)", width: 1080, height: 1920, aspect: "9:16" },
  { label: "720p Vertical (720x1280)", width: 720, height: 1280, aspect: "9:16" },
  { label: "480p Vertical (480x854)", width: 480, height: 854, aspect: "9:16" },
  { label: "360p Vertical (360x640)", width: 360, height: 640, aspect: "9:16" },

  // --- 1:1 ---
  { label: "Square (1080x1080)", width: 1080, height: 1080, aspect: "1:1" },
  { label: "Square (720x720)", width: 720, height: 720, aspect: "1:1" },
  { label: "Square (480x480)", width: 480, height: 480, aspect: "1:1" },

  // --- 4:3 ---
  { label: "1024x768 (XGA)", width: 1024, height: 768, aspect: "4:3" },
  { label: "800x600 (SVGA)", width: 800, height: 600, aspect: "4:3" },
  { label: "640x480 (VGA)", width: 640, height: 480, aspect: "4:3" }
];

const FPS_OPTIONS = [24, 25, 30, 50, 60];

export function ExportDialog({ open, onOpenChange }: ExportDialogProps) {
  const { tracks } = useTimelineStore();
  const { mediaItems } = useMediaStore();
  const { canvasSize } = useEditorStore();
  const [progress, setProgress] = useState(0);
  const [isExporting, setIsExporting] = useState(false);
  const { isLoaded, error, worker } = useFFmpegWorker();
  const [exportMessage, setExportMessage] = useState("");
  const activeExportRef = useRef<boolean>(false);
  const messageHandlerRef = useRef<((event: MessageEvent) => void) | null>(null);

  // Find matching resolution preset
  const findMatchingPreset = () => {
    const preset = RESOLUTION_PRESETS.find((preset) => preset.width === canvasSize.width && preset.height === canvasSize.height);
    return preset || RESOLUTION_PRESETS[1]; // Default to 1080p if no match
  };

  const [options, setOptions] = useState<ExportOptions>({
    fps: 30,
    format: "mp4",
    quality: "high",
    resolution: findMatchingPreset()
  });

  // Filter presets by aspect ratio
  const getFilteredPresets = () => {
    const canvasAspectRatio = canvasSize.width / canvasSize.height;
    return RESOLUTION_PRESETS.filter((preset) => {
      const presetAspectRatio = preset.width / preset.height;
      // Allow small tolerance for floating point comparison
      return Math.abs(presetAspectRatio - canvasAspectRatio) < 0.01;
    });
  };

  const FILTERED_RESOLUTION_PRESETS = getFilteredPresets();

  const duration = calculateTimelineDuration(tracks);
  const hasContent = duration > 0 && mediaItems.length > 0;

  // Estimate file size (rough approximation)
  const estimateFileSize = () => {
    const bitrates = {
      high: { video: 5, audio: 0.192 },
      medium: { video: 2, audio: 0.128 },
      low: { video: 1, audio: 0.096 }
    };

    const bitrate = bitrates[options.quality];
    const totalBitrate = bitrate.video + bitrate.audio; // Mbps
    const sizeInMB = duration * totalBitrate * 0.125; // Convert to MB

    // Adjust for resolution
    const resolutionFactor = (options.resolution.width * options.resolution.height) / (1920 * 1080);
    const adjustedSize = sizeInMB * Math.sqrt(resolutionFactor);

    // Add format overhead
    const formatOverhead = options.format === "webm" ? 0.9 : 1.1;
    const finalSize = adjustedSize * formatOverhead;

    return finalSize.toFixed(1);
  };

  // Clean up previous export handler
  const cleanupExportHandler = () => {
    if (messageHandlerRef.current && worker) {
      worker.removeEventListener("message", messageHandlerRef.current);
      messageHandlerRef.current = null;
    }
    activeExportRef.current = false;
  };

  const handleExport = async () => {
    if (!worker || !isLoaded) {
      toast.error("FFmpeg is not ready yet. Please wait and try again.");
      return;
    }

    if (!hasContent) {
      toast.error("Timeline is empty. Add some clips before exporting.");
      return;
    }

    if (activeExportRef.current) {
      toast.error("An export is already in progress. Please wait for it to complete.");
      return;
    }

    try {
      activeExportRef.current = true;
      setIsExporting(true);
      setProgress(0);
      setExportMessage("Initializing export...");

      // Clean up any previous handler
      cleanupExportHandler();

      // Validate media items
      const validMediaItems = mediaItems.filter((item) => {
        if (!item.file) {
          console.warn(`Media item ${item.name} has no file attached`);
          return false;
        }
        return true;
      });

      if (validMediaItems.length === 0) {
        throw new Error("No valid media files found. Please add media to your timeline.");
      }

      // Prepare export data with validated media files
      const exportData = {
        tracks: tracks.map((track) => ({
          ...track,
          clips: (track.clips || []).filter((clip) => {
            // Validate clip references
            const mediaItem = mediaItems.find((item) => item.id === clip.mediaId);
            if (!mediaItem) {
              console.warn(`Clip references non-existent media: ${clip.mediaId}`);
              return false;
            }
            return true;
          })
        })),
        mediaItems: validMediaItems.map((item) => ({
          id: item.id,
          name: item.name,
          type: item.type,
          duration: item.duration,
          file: item.file
        })),
        options
      };

      // Create handler for this export
      const handleWorkerMessage = (event: MessageEvent) => {
        const { type, progress: workerProgress, outputData, fileName, message, error: workerError } = event.data;

        switch (type) {
          case "EXPORT_PROGRESS":
            setProgress(Math.round(workerProgress || 0));
            setExportMessage(message || `Processing... ${Math.round(workerProgress || 0)}%`);
            break;

          case "EXPORT_COMPLETE":
            setProgress(100);
            setExportMessage("Export completed!");

            // Download the exported video
            const blob = new Blob([outputData], { type: `video/${options.format}` });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = fileName || `opencut-export.${options.format}`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);

            // Clean up blob URL after a delay
            setTimeout(() => URL.revokeObjectURL(url), 1000);

            toast.success("Export completed successfully!");

            // Reset state after showing success
            setTimeout(() => {
              onOpenChange(false);
              setIsExporting(false);
              setProgress(0);
              setExportMessage("");
              cleanupExportHandler();
            }, 1000);
            break;

          case "EXPORT_ERROR":
            console.error("Export error:", workerError);
            toast.error(workerError || "Failed to export video. Please try again.");
            setIsExporting(false);
            setProgress(0);
            setExportMessage("");
            cleanupExportHandler();
            break;
        }
      };

      // Store reference and add listener
      messageHandlerRef.current = handleWorkerMessage;
      worker.addEventListener("message", handleWorkerMessage);

      // Send export request to worker
      worker.postMessage({
        type: "EXPORT_PROJECT",
        data: exportData
      });
    } catch (error) {
      console.error("Export failed:", error);
      toast.error(error instanceof Error ? error.message : "Failed to export video. Please try again.");
      setIsExporting(false);
      setProgress(0);
      setExportMessage("");
      cleanupExportHandler();
    }
  };

  // Clean up on unmount
  useEffect(() => {
    return () => {
      cleanupExportHandler();
    };
  }, [worker]);

  // Update resolution when canvas size changes
  useEffect(() => {
    if (canvasSize && !isExporting) {
      const matchedPresets = getFilteredPresets();
      if (matchedPresets.length > 0) {
        setOptions((prev) => ({
          ...prev,
          resolution: matchedPresets[0]
        }));
      }
    }
  }, [canvasSize, isExporting]);

  // Handle dialog close
  const handleDialogClose = (open: boolean) => {
    if (isExporting) {
      toast.error("Cannot close dialog while exporting. Please wait for the export to complete.");
      return;
    }
    onOpenChange(open);
  };

  return (
    <Dialog open={open} onOpenChange={handleDialogClose}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileVideo className="h-5 w-5" />
            Export Project
          </DialogTitle>
          <DialogDescription>Configure your export settings and render your video</DialogDescription>
        </DialogHeader>

        {error && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>Error loading video processor: {error}</AlertDescription>
          </Alert>
        )}

        {!isLoaded && !error && (
          <Alert>
            <Info className="h-4 w-4" />
            <AlertDescription>Loading video processor... Please wait.</AlertDescription>
          </Alert>
        )}

        {!hasContent && isLoaded && (
          <Alert>
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>Your timeline is empty. Add some clips before exporting.</AlertDescription>
          </Alert>
        )}

        {isLoaded && !error && (
          <Tabs defaultValue="basic" className="w-full">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="basic" disabled={isExporting}>
                Basic
              </TabsTrigger>
              <TabsTrigger value="advanced" disabled={isExporting}>
                Advanced
              </TabsTrigger>
            </TabsList>

            <TabsContent value="basic" className="space-y-4">
              <div className="grid gap-4">
                <div className="grid gap-2">
                  <Label>Format</Label>
                  <Select value={options.format} onValueChange={(value: ExportOptions["format"]) => setOptions({ ...options, format: value })} disabled={isExporting}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="mp4">
                        <div className="flex flex-col items-start">
                          <div className="font-medium">MP4</div>
                          <div className="text-xs text-muted-foreground">Most compatible, H.264 codec</div>
                        </div>
                      </SelectItem>
                      <SelectItem value="webm">
                        <div className="flex flex-col items-start">
                          <div className="font-medium">WebM</div>
                          <div className="text-xs text-muted-foreground">Web-optimized, VP8 codec</div>
                        </div>
                      </SelectItem>
                      <SelectItem value="mov">
                        <div className="flex flex-col items-start">
                          <div className="font-medium">MOV</div>
                          <div className="text-xs text-muted-foreground">Apple-compatible, H.264 codec</div>
                        </div>
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="grid gap-2">
                  <Label>Resolution</Label>
                  <Select
                    value={`${options.resolution.width}x${options.resolution.height}`}
                    onValueChange={(value) => {
                      const [width, height] = value.split("x").map(Number);
                      setOptions({
                        ...options,
                        resolution: { width, height }
                      });
                    }}
                    disabled={isExporting}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {FILTERED_RESOLUTION_PRESETS.length > 0 ? (
                        FILTERED_RESOLUTION_PRESETS.map((preset) => (
                          <SelectItem key={preset.label} value={`${preset.width}x${preset.height}`} disabled={preset.premium && options.format === "webm"}>
                            <div className="flex items-center justify-between w-full">
                              <span>{preset.label}</span>
                              {preset.premium && <span className="text-xs text-muted-foreground ml-2">{options.format === "webm" ? "Not available for WebM" : "Large file size"}</span>}
                            </div>
                          </SelectItem>
                        ))
                      ) : (
                        <SelectItem value={`${options.resolution.width}x${options.resolution.height}`}>
                          Custom ({options.resolution.width}x{options.resolution.height})
                        </SelectItem>
                      )}
                    </SelectContent>
                  </Select>
                </div>

                <div className="grid gap-2">
                  <Label>Quality</Label>
                  <Select value={options.quality} onValueChange={(value: ExportOptions["quality"]) => setOptions({ ...options, quality: value })} disabled={isExporting}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="high">
                        <div className="flex flex-col items-start">
                          <div className="font-medium">High Quality</div>
                          <div className="text-xs text-muted-foreground">Best quality, larger file</div>
                        </div>
                      </SelectItem>
                      <SelectItem value="medium">
                        <div className="flex flex-col items-start">
                          <div className="font-medium">Medium Quality</div>
                          <div className="text-xs text-muted-foreground">Balanced size and quality</div>
                        </div>
                      </SelectItem>
                      <SelectItem value="low">
                        <div className="flex flex-col items-start">
                          <div className="font-medium">Low Quality</div>
                          <div className="text-xs text-muted-foreground">Smaller file, reduced quality</div>
                        </div>
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {duration > 0 && (
                  <div className="grid gap-2">
                    <Label className="text-sm text-muted-foreground">Export Info</Label>
                    <div className="space-y-1 text-sm">
                      <div className="flex justify-between">
                        <span>Duration:</span>
                        <span className="font-medium">{formatDuration(duration)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span>Estimated Size:</span>
                        <span className="font-medium">~{estimateFileSize()} MB</span>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </TabsContent>

            <TabsContent value="advanced" className="space-y-4">
              <div className="grid gap-4">
                <div className="grid gap-2">
                  <Label>Frame Rate (FPS)</Label>
                  <Select value={options.fps.toString()} onValueChange={(value) => setOptions({ ...options, fps: parseInt(value) })} disabled={isExporting}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {FPS_OPTIONS.map((fps) => (
                        <SelectItem key={fps} value={fps.toString()}>
                          {fps} FPS {fps === 24 && "(Cinema)"} {fps === 30 && "(Standard)"} {fps === 60 && "(Smooth)"}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label>Hardware Acceleration</Label>
                    <Switch disabled />
                  </div>
                  <p className="text-xs text-muted-foreground">Coming soon - Will speed up exports significantly</p>
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label>Include Audio</Label>
                    <Switch defaultChecked disabled={isExporting} />
                  </div>
                  <p className="text-xs text-muted-foreground">Export with audio tracks from timeline</p>
                </div>
              </div>
            </TabsContent>
          </Tabs>
        )}

        {isExporting && (
          <div className="space-y-3">
            <div className="grid gap-2">
              <div className="flex justify-between text-sm">
                <span>Export Progress</span>
                <span className="font-medium">{Math.round(progress)}%</span>
              </div>
              <Progress value={progress} className="h-2" />
              {exportMessage && <div className="text-sm text-muted-foreground animate-pulse">{exportMessage}</div>}
            </div>
          </div>
        )}

        <div className="flex justify-end gap-3 mt-6">
          <Button variant="outline" onClick={() => handleDialogClose(false)} disabled={isExporting}>
            {isExporting ? "Export in Progress" : "Cancel"}
          </Button>
          <Button onClick={handleExport} disabled={isExporting || !isLoaded || !hasContent} className="min-w-[120px]">
            {isExporting ? (
              <>
                <div className="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-primary border-r-transparent" />
                Exporting...
              </>
            ) : (
              <>
                <FileVideo className="mr-2 h-4 w-4" />
                Export Video
              </>
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// Helper function to format duration
function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = Math.floor(seconds % 60);

  if (hours > 0) {
    return `${hours}h ${minutes}m ${remainingSeconds}s`;
  } else if (minutes > 0) {
    return `${minutes}m ${remainingSeconds}s`;
  }
  return `${remainingSeconds}s`;
}
