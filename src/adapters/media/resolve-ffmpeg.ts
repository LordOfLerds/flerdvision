import { accessSync, constants } from "node:fs";
import { delimiter, join, resolve } from "node:path";

function executable(path:string):boolean{try{accessSync(path,constants.X_OK);return true;}catch{return false;}}

/**
 * Same resolution rules as the ffprobe lookup: an explicit configured path wins, then the
 * platform's usual install locations, then PATH. Kept separate from ffprobe because a host can
 * genuinely have one and not the other, and because the screencast treats a missing ffmpeg as a
 * skipped recording rather than a failure -- the caller catches this and moves on.
 */
export function resolveFfmpegExecutablePath(explicit:string|undefined=process.env.FFMPEG_EXECUTABLE_PATH):string{
  if(explicit?.trim()){
    const path=resolve(explicit.trim());
    if(!executable(path))throw new Error(`Configured ffmpeg is missing or not executable: ${path}`);
    return path;
  }
  const candidates=[
    ...(process.platform==="darwin"?["/opt/homebrew/bin/ffmpeg","/usr/local/bin/ffmpeg"]:[]),
    "/usr/bin/ffmpeg",
    ...((process.env.PATH??"").split(delimiter).filter(Boolean).map(dir=>join(dir,"ffmpeg")))
  ];
  for(const candidate of [...new Set(candidates)])if(executable(candidate))return resolve(candidate);
  throw new Error("ffmpeg executable not found. Install ffmpeg or set FFMPEG_EXECUTABLE_PATH.");
}
