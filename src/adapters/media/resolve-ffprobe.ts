import { accessSync, constants } from "node:fs";
import { delimiter, join, resolve } from "node:path";

function executable(path:string):boolean{try{accessSync(path,constants.X_OK);return true;}catch{return false;}}

export function resolveFfprobeExecutablePath(explicit:string|undefined=process.env.FFPROBE_EXECUTABLE_PATH):string{
  if(explicit?.trim()){
    const path=resolve(explicit.trim());
    if(!executable(path))throw new Error(`Configured ffprobe is missing or not executable: ${path}`);
    return path;
  }
  const candidates=[
    ...(process.platform==="darwin"?["/opt/homebrew/bin/ffprobe","/usr/local/bin/ffprobe"]:[]),
    "/usr/bin/ffprobe",
    ...((process.env.PATH??"").split(delimiter).filter(Boolean).map(dir=>join(dir,"ffprobe")))
  ];
  for(const candidate of [...new Set(candidates)])if(executable(candidate))return resolve(candidate);
  throw new Error("ffprobe executable not found. Install ffmpeg/ffprobe or set FFPROBE_EXECUTABLE_PATH.");
}
