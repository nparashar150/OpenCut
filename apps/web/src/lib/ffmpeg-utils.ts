import { TimelineTrack } from "@/stores/timeline-store";
import { FFmpeg } from "@ffmpeg/ffmpeg";
import { toBlobURL } from "@ffmpeg/util";

let ffmpeg: FFmpeg | null = null;

export const initFFmpeg = async (): Promise<FFmpeg> => {
  if (ffmpeg) return ffmpeg;

  ffmpeg = new FFmpeg();

  const baseURL = "https://unpkg.com/@ffmpeg/core@0.12.10/dist/umd";

  await ffmpeg.load({
    coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, "text/javascript"),
    wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, "application/wasm")
  });

  postMessage({ type: "FFMPEG_LOADED" });
  return ffmpeg;
};

export const generateThumbnail = async (videoFile: File, timeInSeconds: number = 1): Promise<string> => {
  const ffmpeg = await initFFmpeg();

  const inputName = "input.mp4";
  const outputName = "thumbnail.jpg";

  // Write input file
  await ffmpeg.writeFile(inputName, new Uint8Array(await videoFile.arrayBuffer()));

  // Generate thumbnail at specific time
  await ffmpeg.exec(["-i", inputName, "-ss", timeInSeconds.toString(), "-vframes", "1", "-vf", "scale=320:240", "-q:v", "2", outputName]);

  // Read output file
  const data = await ffmpeg.readFile(outputName);
  const blob = new Blob([data], { type: "image/jpeg" });

  // Cleanup
  await ffmpeg.deleteFile(inputName);
  await ffmpeg.deleteFile(outputName);

  return URL.createObjectURL(blob);
};

export const trimVideo = async (videoFile: File, startTime: number, endTime: number, onProgress?: (progress: number) => void): Promise<Blob> => {
  const ffmpeg = await initFFmpeg();

  const inputName = "input.mp4";
  const outputName = "output.mp4";

  // Set up progress callback
  if (onProgress) {
    ffmpeg.on("progress", ({ progress }) => {
      onProgress(progress * 100);
    });
  }

  // Write input file
  await ffmpeg.writeFile(inputName, new Uint8Array(await videoFile.arrayBuffer()));

  const duration = endTime - startTime;

  // Trim video
  await ffmpeg.exec([
    "-i",
    inputName,
    "-ss",
    startTime.toString(),
    "-t",
    duration.toString(),
    "-c",
    "copy", // Use stream copy for faster processing
    outputName
  ]);

  // Read output file
  const data = await ffmpeg.readFile(outputName);
  const blob = new Blob([data], { type: "video/mp4" });

  // Cleanup
  await ffmpeg.deleteFile(inputName);
  await ffmpeg.deleteFile(outputName);

  return blob;
};

export const getVideoInfo = async (
  videoFile: File
): Promise<{
  duration: number;
  width: number;
  height: number;
  fps: number;
}> => {
  const ffmpeg = await initFFmpeg();

  const inputName = "input.mp4";

  // Write input file
  await ffmpeg.writeFile(inputName, new Uint8Array(await videoFile.arrayBuffer()));

  // Capture FFmpeg stderr output with a one-time listener pattern
  let ffmpegOutput = "";
  let listening = true;
  const listener = (data: string) => {
    if (listening) ffmpegOutput += data;
  };
  ffmpeg.on("log", ({ message }) => listener(message));

  // Run ffmpeg to get info (stderr will contain the info)
  try {
    await ffmpeg.exec(["-i", inputName, "-f", "null", "-"]);
  } catch (error) {
    listening = false;
    await ffmpeg.deleteFile(inputName);
    console.error("FFmpeg execution failed:", error);
    throw new Error("Failed to extract video info. The file may be corrupted or in an unsupported format.");
  }

  // Disable listener after exec completes
  listening = false;

  // Cleanup
  await ffmpeg.deleteFile(inputName);

  // Parse output for duration, resolution, and fps
  // Example: Duration: 00:00:10.00, start: 0.000000, bitrate: 1234 kb/s
  // Example: Stream #0:0: Video: h264 (High), yuv420p(progressive), 1920x1080 [SAR 1:1 DAR 16:9], 30 fps, 30 tbr, 90k tbn, 60 tbc

  const durationMatch = ffmpegOutput.match(/Duration: (\d+):(\d+):([\d.]+)/);
  let duration = 0;
  if (durationMatch) {
    const [, h, m, s] = durationMatch;
    duration = parseInt(h) * 3600 + parseInt(m) * 60 + parseFloat(s);
  }

  const videoStreamMatch = ffmpegOutput.match(/Video:.* (\d+)x(\d+)[^,]*, ([\d.]+) fps/);
  let width = 0,
    height = 0,
    fps = 0;
  if (videoStreamMatch) {
    width = parseInt(videoStreamMatch[1]);
    height = parseInt(videoStreamMatch[2]);
    fps = parseFloat(videoStreamMatch[3]);
  }

  return {
    duration,
    width,
    height,
    fps
  };
};

export const convertToWebM = async (videoFile: File, onProgress?: (progress: number) => void): Promise<Blob> => {
  const ffmpeg = await initFFmpeg();

  const inputName = "input.mp4";
  const outputName = "output.webm";

  // Set up progress callback
  if (onProgress) {
    ffmpeg.on("progress", ({ progress }) => {
      onProgress(progress * 100);
    });
  }

  // Write input file
  await ffmpeg.writeFile(inputName, new Uint8Array(await videoFile.arrayBuffer()));

  // Convert to WebM
  await ffmpeg.exec(["-i", inputName, "-c:v", "libvpx-vp9", "-crf", "30", "-b:v", "0", "-c:a", "libopus", outputName]);

  // Read output file
  const data = await ffmpeg.readFile(outputName);
  const blob = new Blob([data], { type: "video/webm" });

  // Cleanup
  await ffmpeg.deleteFile(inputName);
  await ffmpeg.deleteFile(outputName);

  return blob;
};

export const extractAudio = async (videoFile: File, format: "mp3" | "wav" = "mp3"): Promise<Blob> => {
  const ffmpeg = await initFFmpeg();

  const inputName = "input.mp4";
  const outputName = `output.${format}`;

  // Write input file
  await ffmpeg.writeFile(inputName, new Uint8Array(await videoFile.arrayBuffer()));

  // Extract audio
  await ffmpeg.exec([
    "-i",
    inputName,
    "-vn", // Disable video
    "-acodec",
    format === "mp3" ? "libmp3lame" : "pcm_s16le",
    outputName
  ]);

  // Read output file
  const data = await ffmpeg.readFile(outputName);
  const blob = new Blob([data], { type: `audio/${format}` });

  // Cleanup
  await ffmpeg.deleteFile(inputName);
  await ffmpeg.deleteFile(outputName);

  return blob;
};

// Helper function to calculate timeline duration
export const calculateTimelineDuration = (tracks: any[]): number => {
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
// Build timeline-based FFmpeg command
const buildTimelineFFmpegCommand = (tracks: TimelineTrack[], mediaItemMap: Map<string, any>, mediaFileMap: Map<string, string>, outputFileName: string, options: any, timelineDuration: number): string[] => {
  const { format, resolution, quality, fps } = options;

  // Quality settings
  const qualitySettings = {
    high: { crf: "18", preset: "slow", videoBitrate: "5M", audioBitrate: "192k" },
    medium: { crf: "23", preset: "medium", videoBitrate: "2M", audioBitrate: "128k" },
    low: { crf: "28", preset: "fast", videoBitrate: "1M", audioBitrate: "96k" }
  };

  const settings = qualitySettings[quality as keyof typeof qualitySettings] || qualitySettings.medium;

  // Separate tracks by type
  const videoTracks = tracks.filter((t) => t.type === "video");
  const audioTracks = tracks.filter((t) => t.type === "audio");

  // Basic command structure
  let args = [];
  let filterComplex = [];
  let inputIndex = 0;
  const inputMap = new Map<string, number>();

  // First, add all unique input files based on clips
  const addedFiles = new Set<string>();
  tracks.forEach((track) => {
    track.clips?.forEach((clip: any) => {
      // Use mediaId field from TimelineClip interface
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
    if (track.muted) return;

    track.clips?.forEach((clip, clipIndex: number) => {
      const mediaId = clip.mediaId;
      if (!mediaId || !inputMap.has(mediaId)) return;

      const inputIdx = inputMap.get(mediaId)!;
      const mediaItem = mediaItemMap.get(mediaId);

      if (mediaItem?.type === "video" || mediaItem?.type === "image") {
        const clipLabel = `[v${trackIndex}_${clipIndex}]`;

        if (mediaItem.type === "video") {
          // For video: trim from the original media file
          // clip.duration is the duration on the timeline
          // trimStart is where to start in the source file
          // trimEnd is where to end in the source file
          const sourceStart = clip.trimStart;
          const trimDuration = clip.duration - clip.trimStart - clip.trimEnd;

          // Calculate the actual trim duration from the source
          // If trimEnd is 0 or not set, calculate it based on clip duration
          videoFilterSteps.push(
            `[${inputIdx}:v]` +
              `trim=start=${sourceStart}:duration=${trimDuration},` +
              `setpts=PTS-STARTPTS,` +
              `scale=${resolution.width}:${resolution.height}:force_original_aspect_ratio=increase,` +
              `crop=${resolution.width}:${resolution.height},` +
              `${clipLabel}`
          );

          // Also handle audio from video if exists and no dedicated audio tracks
          if (audioTracks.length === 0) {
            const audioClipLabel = `[va${trackIndex}_${clipIndex}]`;
            audioFilterSteps.push(
              `[${inputIdx}:a]` + `atrim=start=${sourceStart}:duration=${trimDuration},` + `asetpts=PTS-STARTPTS,` + `adelay=${Math.round(clip.startTime * 1000)}|${Math.round(clip.startTime * 1000)}` + `${audioClipLabel}`
            );
            audioInputs.push(audioClipLabel);
          }
        } else {
          // For image: loop and scale
          videoFilterSteps.push(
            `[${inputIdx}:v]` +
              `loop=loop=${Math.ceil(clip.duration * fps)}:size=1:start=0,` +
              `scale=${resolution.width}:${resolution.height}:force_original_aspect_ratio=increase,` +
              `crop=${resolution.width}:${resolution.height},` +
              `trim=duration=${clip.duration},` +
              `setpts=PTS-STARTPTS` +
              `${clipLabel}`
          );
        }

        // Overlay at the correct time
        const overlayLabel = `[voverlay${trackIndex}_${clipIndex}]`;
        videoFilterSteps.push(`${currentVideo}${clipLabel}` + `overlay=0:0:enable='between(t,${clip.startTime},${clip.startTime + clip.duration})'` + `${overlayLabel}`);
        currentVideo = overlayLabel;
      }
    });
  });

  // Process audio tracks
  audioTracks.forEach((track, trackIndex) => {
    if (track.muted) return;

    track.clips?.forEach((clip, clipIndex: number) => {
      const mediaId = clip.mediaId;
      if (!mediaId || !inputMap.has(mediaId)) return;

      const inputIdx = inputMap.get(mediaId)!;
      const mediaItem = mediaItemMap.get(mediaId);

      if (mediaItem?.type === "audio" || mediaItem?.type === "video") {
        const clipLabel = `[a${trackIndex}_${clipIndex}]`;

        // Calculate source trim duration
        const sourceStart = clip.trimStart;
        const trimDuration = clip.duration - clip.trimStart - clip.trimEnd;

        // Build audio filter chain
        let audioFilter = `[${inputIdx}:a]`;

        // Trim audio from source
        audioFilter += `atrim=start=${sourceStart}:duration=${trimDuration},`;
        audioFilter += `asetpts=PTS-STARTPTS,`;

        // Delay to correct position on timeline
        audioFilter += `adelay=${Math.round(clip.startTime * 1000)}|${Math.round(clip.startTime * 1000)}`;
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
    // Single audio or no audio mixing needed
    args.push("-filter_complex", filterComplex.join(";"));
    args.push("-map", currentVideo);
    args.push("-map", audioInputs[0]);
  } else {
    // No filters needed (shouldn't happen in practice)
    args.push("-map", currentVideo);
    args.push("-map", audioInputs[0]);
  }

  // Video encoding settings
  if (format === "webm") {
    args.push("-c:v", "libvpx", "-crf", settings.crf, "-b:v", settings.videoBitrate, "-cpu-used", "0", "-c:a", "libvorbis", "-b:a", settings.audioBitrate);
  } else {
    // MP4 or MOV
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

  try {
    const { tracks, mediaItems, options } = data;

    postMessage({
      type: "EXPORT_PROGRESS",
      progress: 5,
      message: "Analyzing timeline..."
    });

    // Calculate timeline duration
    const timelineDuration = calculateTimelineDuration(tracks);

    if (timelineDuration === 0) {
      throw new Error("Timeline is empty. Add some clips before exporting.");
    }

    // Create media maps
    const mediaItemMap = new Map<string, any>();
    mediaItems.forEach((item: any) => {
      mediaItemMap.set(item.id, item);
    });

    postMessage({
      type: "EXPORT_PROGRESS",
      progress: 10,
      message: "Loading media files..."
    });

    // Process and upload media files to FFmpeg virtual filesystem
    const mediaFileMap = new Map<string, string>();
    let fileIndex = 0;

    for (const [itemId, mediaItem] of mediaItemMap) {
      if (mediaItem.file) {
        const extension = mediaItem.file.name.split(".").pop() || "mp4";
        const fileName = `input_${fileIndex}.${extension}`;

        try {
          const arrayBuffer = await mediaItem.file.arrayBuffer();
          await ffmpeg.writeFile(fileName, new Uint8Array(arrayBuffer));
          mediaFileMap.set(itemId, fileName);
          fileIndex++;

          postMessage({
            type: "EXPORT_PROGRESS",
            progress: 10 + (fileIndex / mediaItemMap.size) * 10,
            message: `Loaded ${mediaItem.name}...`
          });
        } catch (error) {
          console.error(`Failed to load media file ${mediaItem.name}:`, error);
          throw new Error(`Failed to load media file: ${mediaItem.name}`);
        }
      }
    }

    postMessage({
      type: "EXPORT_PROGRESS",
      progress: 25,
      message: "Building export timeline..."
    });

    // Build FFmpeg command
    const outputFileName = `output.${options.format}`;
    const ffmpegArgs = buildTimelineFFmpegCommand(tracks, mediaItemMap, mediaFileMap, outputFileName, options, timelineDuration);

    // Log command for debugging
    console.log("FFmpeg command:", ffmpegArgs.join(" "));

    // Set up progress tracking
    ffmpeg.on("progress", ({ progress, time }) => {
      // Clamp progress between 0 and 1 to prevent exceeding 100%
      postMessage({
        type: "EXPORT_PROGRESS",
        progress: progress * 100,
        message: `Rendering video... ${Math.round(progress * 100)}%`
      });
    });

    postMessage({
      type: "EXPORT_PROGRESS",
      progress: 30,
      message: "Starting video rendering..."
    });

    // Execute FFmpeg command
    await ffmpeg.exec(ffmpegArgs);

    // Read output file
    const outputData = await ffmpeg.readFile(outputFileName);

    // Clean up all files
    for (const fileName of mediaFileMap.values()) {
      try {
        await ffmpeg.deleteFile(fileName);
      } catch (e) {
        // Ignore cleanup errors
      }
    }

    try {
      await ffmpeg.deleteFile(outputFileName);
    } catch (e) {
      // Ignore cleanup errors
    }

    // Generate filename with timestamp
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, -5);
    const exportFileName = `opencut-export-${timestamp}.${options.format}`;

    // Send result back
    postMessage({
      type: "EXPORT_COMPLETE",
      outputData: outputData,
      fileName: exportFileName
    });
  } catch (error) {
    console.error("Export error:", error);
    postMessage({
      type: "EXPORT_ERROR",
      error: error instanceof Error ? error.message : "Unknown export error"
    });
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
