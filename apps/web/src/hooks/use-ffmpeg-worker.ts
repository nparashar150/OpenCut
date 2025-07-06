import { useState, useEffect, useRef } from "react";

export function useFFmpegWorker() {
  const [isLoaded, setIsLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const workerRef = useRef<Worker | null>(null);

  useEffect(() => {
    // Initialize the worker
    try {
      const worker = new Worker(
        new URL("@/lib/ffmpeg-utils.ts", import.meta.url),
        { type: "module" }
      );

      // Set up message handler
      worker.addEventListener("message", (event) => {
        const { type, error: workerError } = event.data;
        
        switch (type) {
          case "FFMPEG_LOADED":
            setIsLoaded(true);
            setError(null);
            break;
            
          case "FFMPEG_ERROR":
            setError(workerError || "Failed to load FFmpeg");
            setIsLoaded(false);
            break;
        }
      });

      // Initialize FFmpeg in the worker
      worker.postMessage({ type: "INIT_FFMPEG" });

      workerRef.current = worker;
    } catch (err) {
      console.error("Failed to create FFmpeg worker:", err);
      setError("Failed to create video processing worker");
    }

    // Cleanup on unmount
    return () => {
      if (workerRef.current) {
        workerRef.current.terminate();
        workerRef.current = null;
      }
    };
  }, []);

  return {
    isLoaded,
    error,
    worker: workerRef.current
  };
}