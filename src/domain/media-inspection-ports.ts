export interface MediaInspectionResult {
  validVideo:boolean;
  durationSeconds?:number;
  formatName?:string;
  videoStreams:number;
  audioStreams:number;
  note?:string;
}

export interface MediaInspectorPort {
  inspect(localPath:string):Promise<MediaInspectionResult>;
}
