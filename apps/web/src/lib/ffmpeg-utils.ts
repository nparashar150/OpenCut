import { TimelineTrack } from "@/stores/timeline-store";
import { FFmpeg } from "@ffmpeg/ffmpeg";
import { toBlobURL } from "@ffmpeg/util";

let ffmpeg: FFmpeg | null = null;
let activeProgressListeners: Array<() => void> = [];
let activeLogListeners: Array<() => void> = [];

// Helper to add listeners with cleanup tracking
const addFFmpegListener = (type: "progress" | "log", handler: (data: any) => void): (() => void) => {
  if (!ffmpeg) throw new Error("FFmpeg not initialized");

  if (type === "progress") ffmpeg.on("progress", handler);
  else ffmpeg.on("log", handler);

  const removeListener = () => {
    if (ffmpeg) {
      if (type === "progress") ffmpeg.off("progress", handler);
      else ffmpeg.off("log", handler);
    }
  };

  if (type === "progress") activeProgressListeners.push(removeListener);
  else activeLogListeners.push(removeListener);

  return removeListener;
};

export const initFFmpeg = async (): Promise<FFmpeg> => {
  if (ffmpeg) return ffmpeg;

  try {
    ffmpeg = new FFmpeg();

    const baseURL = "https://unpkg.com/@ffmpeg/core@0.12.10/dist/umd";

    await ffmpeg.load({
      coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, "text/javascript"),
      wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, "application/wasm")
    });

    postMessage({ type: "FFMPEG_LOADED" });
    return ffmpeg;
  } catch (error) {
    postMessage({
      type: "FFMPEG_ERROR",
      error: error instanceof Error ? error.message : "Failed to initialize FFmpeg"
    });
    throw error;
  }
};

// Helper function to calculate timeline duration
export const calculateTimelineDuration = (tracks: TimelineTrack[]): number => {
  let maxDuration = 0;
  for (const track of tracks) {
    if (!track.clips) continue;
    for (const clip of track.clips) {
      // Calculate the actual duration on timeline
      const duration = clip.duration - clip.trimStart - clip.trimEnd;
      if (duration > maxDuration) maxDuration = duration;
    }
  }
  return maxDuration;
};

// Build timeline-based FFmpeg command
const buildTimelineFFmpegCommand = (tracks: TimelineTrack[], mediaItemMap: Map<string, any>, mediaFileMap: Map<string, string>, mediaInfoMap: Map<string, any>, outputFileName: string, options: any, timelineDuration: number): string[] => {
  const { format, resolution, quality, fps } = options;

  // Quality settings
  const qualitySettings = {
    high: { crf: "18", preset: "slow", videoBitrate: "5M", audioBitrate: "192k" },
    medium: { crf: "23", preset: "medium", videoBitrate: "2M", audioBitrate: "128k" },
    low: { crf: "28", preset: "fast", videoBitrate: "1M", audioBitrate: "96k" }
  };

  const settings = qualitySettings[quality as keyof typeof qualitySettings] || qualitySettings.medium;

  // Separate tracks by type
  const videoTracks = tracks.filter((t) => t.type === "video" && !t.muted);
  const audioTracks = tracks.filter((t) => t.type === "audio" && !t.muted);

  // Basic command structure
  let args = [];
  let filterComplex = [];
  let inputIndex = 0;
  const inputMap = new Map<string, number>();

  // First, add all unique input files based on clips
  const addedFiles = new Set<string>();
  tracks.forEach((track) => {
    if (!track.clips) return;
    track.clips.forEach((clip: any) => {
      const mediaId = clip.mediaId;
      if (mediaId && mediaFileMap.has(mediaId) && !addedFiles.has(mediaId)) {
        const fileName = mediaFileMap.get(mediaId)!;
        args.push("-i", fileName);
        inputMap.set(mediaId, inputIndex);
        inputIndex++;
        addedFiles.add(mediaId);
      }
    });
  });

  // Create a black video as background
  args.push("-f", "lavfi", "-i", `color=c=black:s=${resolution.width}x${resolution.height}:d=${timelineDuration}:r=${fps}`);
  const blackVideoIndex = inputIndex++;

  // Create silence audio
  args.push("-f", "lavfi", "-i", `anullsrc=channel_layout=stereo:sample_rate=48000:d=${timelineDuration}`);
  const silenceAudioIndex = inputIndex++;

  // Initialize with black video and silence
  let currentVideo = `[${blackVideoIndex}:v]`;
  let audioInputs: string[] = [`[${silenceAudioIndex}:a]`];
  let videoFilterSteps: string[] = [];
  let audioFilterSteps: string[] = [];

  // Process video tracks (layer by layer)
  videoTracks.forEach((track, trackIndex) => {
    if (!track.clips) return;

    track.clips.forEach((clip, clipIndex: number) => {
      const mediaId = clip.mediaId;
      if (!mediaId || !inputMap.has(mediaId)) return;

      const inputIdx = inputMap.get(mediaId)!;
      const mediaItem = mediaItemMap.get(mediaId);
      const mediaInfo = mediaInfoMap.get(mediaId);

      if (mediaItem?.type === "video" || mediaItem?.type === "image") {
        const clipLabel = `[v${trackIndex}_${clipIndex}]`;

        if (mediaItem.type === "video") {
          // For video: properly calculate trim
          const sourceStart = clip.trimStart || 0;
          const sourceDuration = mediaInfo?.duration || clip.duration;
          const trimEnd = clip.trimEnd || 0;

          // Calculate actual trim duration from source
          const availableDuration = sourceDuration - sourceStart - trimEnd;
          const trimDuration = Math.min(clip.duration, availableDuration);

          // Video filter with proper escaping
          videoFilterSteps.push(
            `[${inputIdx}:v]` +
              `trim=start=${sourceStart}:duration=${trimDuration},` +
              `setpts=PTS-STARTPTS,` +
              `scale=${resolution.width}:${resolution.height}:force_original_aspect_ratio=decrease,` +
              `pad=${resolution.width}:${resolution.height}:(ow-iw)/2:(oh-ih)/2:black` +
              `${clipLabel}`
          );

          // Handle audio from video if exists and no dedicated audio tracks
          if (audioTracks.length === 0 && mediaInfo?.hasAudio) {
            const audioClipLabel = `[va${trackIndex}_${clipIndex}]`;
            const delayMs = Math.round(clip.startTime * 1000);
            audioFilterSteps.push(`[${inputIdx}:a]` + `atrim=start=${sourceStart}:duration=${trimDuration},` + `asetpts=PTS-STARTPTS,` + `adelay=${delayMs}|${delayMs}` + `${audioClipLabel}`);
            audioInputs.push(audioClipLabel);
          }
        } else {
          // For image: loop and scale
          const loopCount = Math.ceil(clip.duration * fps);
          videoFilterSteps.push(
            `[${inputIdx}:v]` +
              `loop=loop=${loopCount}:size=1:start=0,` +
              `scale=${resolution.width}:${resolution.height}:force_original_aspect_ratio=decrease,` +
              `pad=${resolution.width}:${resolution.height}:(ow-iw)/2:(oh-ih)/2:black,` +
              `trim=duration=${clip.duration},` +
              `setpts=PTS-STARTPTS` +
              `${clipLabel}`
          );
        }

        // Overlay at the correct time
        const overlayLabel = `[voverlay${trackIndex}_${clipIndex}]`;
        const endTime = clip.startTime + clip.duration;
        videoFilterSteps.push(`${currentVideo}${clipLabel}` + `overlay=0:0:enable='between(t,${clip.startTime},${endTime})'` + `${overlayLabel}`);
        currentVideo = overlayLabel;
      }
    });
  });

  // Process audio tracks
  audioTracks.forEach((track, trackIndex) => {
    if (!track.clips) return;

    track.clips.forEach((clip, clipIndex: number) => {
      const mediaId = clip.mediaId;
      if (!mediaId || !inputMap.has(mediaId)) return;

      const inputIdx = inputMap.get(mediaId)!;
      const mediaItem = mediaItemMap.get(mediaId);
      const mediaInfo = mediaInfoMap.get(mediaId);

      if ((mediaItem?.type === "audio" || mediaItem?.type === "video") && mediaInfo?.hasAudio) {
        const clipLabel = `[a${trackIndex}_${clipIndex}]`;

        // Calculate source trim duration
        const sourceStart = clip.trimStart || 0;
        const sourceDuration = mediaInfo?.duration || clip.duration;
        const trimEnd = clip.trimEnd || 0;
        const availableDuration = sourceDuration - sourceStart - trimEnd;
        const trimDuration = Math.min(clip.duration, availableDuration);

        // Build audio filter chain
        const delayMs = Math.round(clip.startTime * 1000);
        let audioFilter = `[${inputIdx}:a]`;
        audioFilter += `atrim=start=${sourceStart}:duration=${trimDuration},`;
        audioFilter += `asetpts=PTS-STARTPTS,`;
        audioFilter += `adelay=${delayMs}|${delayMs}`;
        audioFilter += clipLabel;

        audioFilterSteps.push(audioFilter);
        audioInputs.push(clipLabel);
      }
    });
  });

  // Build final filter complex
  if (videoFilterSteps.length > 0) {
    filterComplex.push(...videoFilterSteps);
  }

  if (audioFilterSteps.length > 0) {
    filterComplex.push(...audioFilterSteps);
  }

  // Mix all audio inputs if we have multiple
  if (audioInputs.length > 1) {
    const mixedAudioLabel = "[outa]";
    filterComplex.push(`${audioInputs.join("")}amix=inputs=${audioInputs.length}:duration=longest:dropout_transition=2${mixedAudioLabel}`);
    args.push("-filter_complex", filterComplex.join(";"));
    args.push("-map", currentVideo);
    args.push("-map", mixedAudioLabel);
  } else if (filterComplex.length > 0) {
    args.push("-filter_complex", filterComplex.join(";"));
    args.push("-map", currentVideo);
    args.push("-map", audioInputs[0]);
  } else {
    args.push("-map", currentVideo);
    args.push("-map", audioInputs[0]);
  }

  // Video encoding settings
  if (format === "webm") {
    args.push("-c:v", "libvpx", "-crf", settings.crf, "-b:v", settings.videoBitrate, "-cpu-used", "0", "-c:a", "libvorbis", "-b:a", settings.audioBitrate);
  } else {
    args.push("-c:v", "libx264", "-preset", settings.preset, "-crf", settings.crf, "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-c:a", "aac", "-b:a", settings.audioBitrate);
  }

  // Frame rate
  args.push("-r", fps.toString());

  // Duration
  args.push("-t", timelineDuration.toString());

  // Format-specific flags
  if (format === "webm") {
    args.push("-f", "webm");
  } else if (format === "mov") {
    args.push("-f", "mov");
  }

  // Output file
  args.push("-y", outputFileName); // -y to overwrite

  return args;
};

// Export project function
const exportProject = async (data: any) => {
  if (!ffmpeg) {
    postMessage({ type: "EXPORT_ERROR", error: "FFmpeg not loaded" });
    return;
  }

  let removeProgressListener: (() => void) | null = null;
  const loadedFiles: string[] = [];

  try {
    const { tracks, mediaItems, options } = data;

    console.log("Starting export with tracks:", tracks, "mediaItems:", mediaItems);

    // Calculate timeline duration
    const timelineDuration = calculateTimelineDuration(tracks);

    if (timelineDuration === 0) {
      throw new Error("Timeline is empty. Add some clips before exporting.");
    }

    console.log("Timeline duration:", timelineDuration);

    // Create media maps
    const mediaItemMap = new Map<string, any>();
    const mediaInfoMap = new Map<string, any>();
    mediaItems.forEach((item: any) => {
      mediaItemMap.set(item.id, item);
    });

    // Process and upload media files to FFmpeg virtual filesystem
    const mediaFileMap = new Map<string, string>();
    let fileIndex = 0;
    const totalFiles = Array.from(mediaItemMap.values()).filter((item) => item.file).length;

    console.log(`Loading ${totalFiles} media files...`);

    for (const [itemId, mediaItem] of mediaItemMap) {
      if (!mediaItem.file) {
        console.log(`Skipping item ${itemId} - no file`);
        continue;
      }

      const extension = mediaItem.file.name.split(".").pop()?.toLowerCase() || "mp4";
      const fileName = `input_${fileIndex}.${extension}`;

      try {
        console.log(`Loading file ${fileIndex + 1}/${totalFiles}: ${mediaItem.name} (${mediaItem.type})`);

        // Skip getVideoInfo for now if it's causing issues
        if (mediaItem.type === "video") {
          // Set basic info without full analysis
          mediaInfoMap.set(itemId, {
            hasAudio: true, // Assume audio exists
            duration: mediaItem.duration || 10,
            width: 1920,
            height: 1080,
            fps: 30
          });
        } else if (mediaItem.type === "audio") {
          mediaInfoMap.set(itemId, { hasAudio: true, duration: mediaItem.duration || 0 });
        } else if (mediaItem.type === "image") {
          mediaInfoMap.set(itemId, { hasAudio: false, duration: 0 });
        }

        // Load file data
        console.log(`Reading arrayBuffer for ${mediaItem.name}...`);
        const arrayBuffer = await mediaItem.file.arrayBuffer();
        console.log(`ArrayBuffer size: ${arrayBuffer.byteLength} bytes`);

        // Write to FFmpeg filesystem
        console.log(`Writing to FFmpeg filesystem as ${fileName}...`);
        await ffmpeg.writeFile(fileName, new Uint8Array(arrayBuffer));

        // Verify file was written
        try {
          const fileData = await ffmpeg.readFile(fileName);
          console.log(`Verified file ${fileName} written successfully, size: ${fileData.length}`);
        } catch (e) {
          console.error(`Failed to verify file ${fileName}:`, e);
        }

        mediaFileMap.set(itemId, fileName);
        loadedFiles.push(fileName);
        fileIndex++;

        const progressPercent = 10 + (fileIndex / totalFiles) * 15;
        console.log(`Progress: ${progressPercent}%`);
      } catch (error) {
        console.error(`Failed to load media file ${mediaItem.name}:`, error);
        throw new Error(`Failed to load media file: ${mediaItem.name}. Error: ${error instanceof Error ? error.message : "Unknown error"}`);
      }
    }

    console.log("All files loaded successfully. Media file map:", mediaFileMap);

    // Validate we have the necessary files
    if (mediaFileMap.size === 0) {
      throw new Error("No media files were loaded successfully");
    }

    // Build FFmpeg command
    const outputFileName = `output.${options.format}`;
    console.log("Building FFmpeg command...");

    const ffmpegArgs = buildTimelineFFmpegCommand(tracks, mediaItemMap, mediaFileMap, mediaInfoMap, outputFileName, options, timelineDuration);

    // Log command for debugging
    console.log("FFmpeg command:", ffmpegArgs.join(" "));

    // Set up progress tracking
    removeProgressListener = addFFmpegListener("progress", ({ progress }) => {
      postMessage({
        type: "EXPORT_PROGRESS",
        progress: progress * 100,
        message: `Rendering video... ${Math.round(progress * 100)}%`
      });
    });

    // Execute FFmpeg command
    console.log("Executing FFmpeg command...");
    await ffmpeg.exec(ffmpegArgs);
    console.log("FFmpeg execution completed");

    // Read output file
    console.log("Reading output file...");
    const outputData = await ffmpeg.readFile(outputFileName);
    console.log(`Output file size: ${outputData.length} bytes`);

    // Generate filename with timestamp
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, -5);
    const exportFileName = `opencut-export-${timestamp}.${options.format}`;

    postMessage({
      type: "EXPORT_PROGRESS",
      progress: 100,
      message: "Export completed!"
    });

    // Send result back
    postMessage({
      type: "EXPORT_COMPLETE",
      outputData: outputData,
      fileName: exportFileName
    });

    // Cleanup output file
    try {
      await ffmpeg.deleteFile(outputFileName);
      console.log("Cleaned up output file");
    } catch (e) {
      console.log("Failed to cleanup output file:", e);
    }
  } catch (error) {
    console.error("Export error:", error);
    postMessage({
      type: "EXPORT_ERROR",
      error: error instanceof Error ? error.message : "Unknown export error"
    });
  } finally {
    // Cleanup all files
    if (removeProgressListener) removeProgressListener();

    console.log(`Cleaning up ${loadedFiles.length} loaded files...`);
    for (const fileName of loadedFiles) {
      try {
        await ffmpeg.deleteFile(fileName);
        console.log(`Cleaned up ${fileName}`);
      } catch (e) {
        console.log(`Failed to cleanup ${fileName}:`, e);
      }
    }
  }
};

// Listen for messages from main thread
addEventListener("message", async (event) => {
  const { type, data } = event.data;

  switch (type) {
    case "INIT_FFMPEG":
      try {
        await initFFmpeg();
      } catch (error) {
        postMessage({
          type: "FFMPEG_ERROR",
          error: error instanceof Error ? error.message : "Failed to load FFmpeg"
        });
      }
      break;

    case "EXPORT_PROJECT":
      await exportProject(data);
      break;
  }
});
