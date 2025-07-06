"use client";

import { useFFmpegWorker } from "@/hooks/use-ffmpeg-worker";
import { ExportOptions } from "@/lib/export-utils";
import { useMediaStore } from "@/stores/media-store";
import { useTimelineStore } from "@/stores/timeline-store";
import { AlertCircle, Download, Info } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui/dialog";
import { Label } from "../ui/label";
import { Progress } from "../ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";

interface ExportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const RESOLUTION_PRESETS = [
  { label: "4K (3840x2160)", width: 3840, height: 2160, premium: true },
  { label: "1080p (1920x1080)", width: 1920, height: 1080 },
  { label: "720p (1280x720)", width: 1280, height: 720 },
  { label: "480p (854x480)", width: 854, height: 480 },
  { label: "360p (640x360)", width: 640, height: 360 }
];

const FPS_OPTIONS = [24, 25, 30, 50, 60];

export function ExportDialog({ open, onOpenChange }: ExportDialogProps) {
  const { tracks } = useTimelineStore();
  const { mediaItems } = useMediaStore();
  const [progress, setProgress] = useState(0);
  const { isLoaded, error, worker } = useFFmpegWorker();
  const [isExporting, setIsExporting] = useState(false);
  const [exportMessage, setExportMessage] = useState("");
  const [options, setOptions] = useState<ExportOptions>({
    format: "mp4",
    resolution: RESOLUTION_PRESETS[1], // Default to 1080p
    quality: "high",
    fps: 30
  });

  const calculateDuration = () => {
    let maxDuration = 0;
    for (const track of tracks) {
      for (const clip of track.clips || []) {
        const duration = clip.duration - clip.trimStart - clip.trimEnd;
        const end = clip.startTime + duration;
        if (end > maxDuration) maxDuration = end;
      }
    }
    return maxDuration;
  };

  const duration = calculateDuration();
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

    return adjustedSize.toFixed(1);
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

    try {
      setIsExporting(true);
      setProgress(0);
      setExportMessage("Initializing export...");

      // Prepare export data with all media files
      const exportData = {
        tracks: tracks.map((track) => ({
          ...track,
          clips: track.clips || []
        })),
        mediaItems: mediaItems.map((item) => ({
          ...item,
          file: item.file // Ensure file is included
        })),
        options
      };

      // Set up worker message handler for this export
      const handleWorkerMessage = (event: MessageEvent) => {
        const { type, progress: workerProgress, outputData, fileName, message, error: workerError } = event.data;

        switch (type) {
          case "EXPORT_PROGRESS":
            setProgress(workerProgress || 0);
            setExportMessage(message || `Processing... ${workerProgress}%`);
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
            URL.revokeObjectURL(url);

            toast.success("Export completed successfully!");
            setTimeout(() => {
              onOpenChange(false);
              setIsExporting(false);
              setProgress(0);
              setExportMessage("");
            }, 1000);
            break;

          case "EXPORT_ERROR":
            console.error("Export error:", workerError);
            toast.error(workerError || "Failed to export video. Please try again.");
            setIsExporting(false);
            setProgress(0);
            setExportMessage("");
            break;
        }
      };

      // Add event listener for this export
      worker.addEventListener("message", handleWorkerMessage);

      // Send export request to worker
      worker.postMessage({
        type: "EXPORT_PROJECT",
        data: exportData
      });

      // Clean up event listener after export (with timeout as fallback)
      setTimeout(() => {
        worker.removeEventListener("message", handleWorkerMessage);
      }, 600000); // 10 minutes timeout
    } catch (error) {
      console.error("Export failed:", error);
      toast.error("Failed to export video. Please try again.");
      setIsExporting(false);
      setProgress(0);
      setExportMessage("");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Download className="h-5 w-5" />
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
              <TabsTrigger value="basic">Basic</TabsTrigger>
              <TabsTrigger value="advanced">Advanced</TabsTrigger>
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
                        <div className="flex flex-col justify-start items-start">
                          <div className="font-medium">MP4</div>
                          <div className="text-xs text-muted-foreground">Most compatible, H.264 codec</div>
                        </div>
                      </SelectItem>
                      <SelectItem value="webm">
                        <div className="flex flex-col justify-start items-start">
                          <div className="font-medium">WebM</div>
                          <div className="text-xs text-muted-foreground">Web-optimized, VP8 codec</div>
                        </div>
                      </SelectItem>
                      <SelectItem value="mov">
                        <div className="flex flex-col justify-start items-start">
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
                      {RESOLUTION_PRESETS.map((preset) => (
                        <SelectItem key={preset.label} value={`${preset.width}x${preset.height}`} disabled={preset.premium && options.format === "webm"}>
                          <div className="flex items-center justify-between w-full">
                            <span>{preset.label}</span>
                            {preset.premium && <span className="text-xs text-muted-foreground ml-2">{options.format === "webm" ? "Not available for WebM" : "Large file size"}</span>}
                          </div>
                        </SelectItem>
                      ))}
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
                        <div className="flex flex-col justify-start items-start">
                          <div className="font-medium">High Quality</div>
                          <div className="text-xs text-muted-foreground">Best quality, larger file</div>
                        </div>
                      </SelectItem>
                      <SelectItem value="medium">
                        <div className="flex flex-col justify-start items-start">
                          <div className="font-medium">Medium Quality</div>
                          <div className="text-xs text-muted-foreground">Balanced size and quality</div>
                        </div>
                      </SelectItem>
                      <SelectItem value="low">
                        <div className="flex flex-col justify-start items-start">
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
                    <Switch defaultChecked />
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
                <span className="font-medium">{progress}%</span>
              </div>
              <Progress value={progress} className="h-2" />
              {exportMessage && <div className="text-sm text-muted-foreground animate-pulse">{exportMessage}</div>}
            </div>
          </div>
        )}

        <div className="flex justify-end gap-3 mt-6">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isExporting}>
            {isExporting ? "Cancel Export" : "Cancel"}
          </Button>
          <Button onClick={handleExport} disabled={isExporting || !isLoaded || !hasContent} className="min-w-[120px]">
            {isExporting ? (
              <>
                <div className="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-primary border-r-transparent" />
                Exporting...
              </>
            ) : (
              <>
                <Download className="mr-2 h-4 w-4" />
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
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.floor(seconds % 60);
  if (minutes > 0) {
    return `${minutes}m ${remainingSeconds}s`;
  }
  return `${remainingSeconds}s`;
}
