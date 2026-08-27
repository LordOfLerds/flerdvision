import { spawnSync } from "node:child_process";
import type { MediaInspectionResult, MediaInspectorPort } from "../../domain/media-inspection-ports.js";

export class FfprobeMediaInspector implements MediaInspectorPort {
  constructor(private readonly executable:string="ffprobe",private readonly timeoutMs:number=15_000){}

  async inspect(localPath:string):Promise<MediaInspectionResult>{
    const result=spawnSync(this.executable,[
      "-v","error",
      "-show_entries","format=duration,format_name:stream=codec_type,codec_name,width,height",
      "-of","json",
      localPath
    ],{encoding:"utf8",timeout:this.timeoutMs,maxBuffer:2*1024*1024,env:{PATH:process.env.PATH??""}});
    if(result.error)throw new Error(`ffprobe execution failed: ${result.error.message}`);
    if(result.status!==0)throw new Error(`ffprobe rejected media: ${(result.stderr??"").trim().slice(0,300)||`exit ${result.status}`}`);
    let parsed:unknown;
    try{parsed=JSON.parse(result.stdout??"");}catch{throw new Error("ffprobe returned invalid JSON");}
    const record=(parsed&&typeof parsed==="object"?parsed:{}) as {format?:Record<string,unknown>;streams?:Array<Record<string,unknown>>};
    const streams=Array.isArray(record.streams)?record.streams:[];
    const videoStreams=streams.filter((item)=>item.codec_type==="video").length;
    const audioStreams=streams.filter((item)=>item.codec_type==="audio").length;
    const durationRaw=record.format?.duration;
    const durationSeconds=typeof durationRaw==="string"||typeof durationRaw==="number"?Number(durationRaw):undefined;
    const formatName=typeof record.format?.format_name==="string"?record.format.format_name:undefined;
    const validVideo=videoStreams>0&&durationSeconds!==undefined&&Number.isFinite(durationSeconds)&&durationSeconds>0;
    return{
      validVideo,
      videoStreams,
      audioStreams,
      ...(durationSeconds!==undefined&&Number.isFinite(durationSeconds)?{durationSeconds}:{}),
      ...(formatName?{formatName}:{}),
      ...(!validVideo?{note:"ffprobe found no positive-duration video stream"}:{})
    };
  }
}
