import type { DistributionConfigurationStorePort } from "../../domain/distribution-ports.js";
import type { ContentItem } from "../../domain/model.js";
import type { LocalMediaArtifact } from "../../domain/platform-ui.js";
import type { MediaMaterializerPort } from "../../domain/platform-ui-ports.js";
import type { AccessTokenProvider } from "../ingress/google-drive.js";
import { GoogleDriveRestMediaMaterializer, LocalFileMediaMaterializer, MediaMaterializationError } from "./media-materializer.js";

/**
 * Resolves the media materializer from immutable ContentItem source metadata + current workspace
 * SourceConnection. The source reference still has to match the connection kind, so config cannot
 * silently reinterpret a local file as Drive (or vice versa).
 */
export class WorkspaceMediaMaterializer implements MediaMaterializerPort {
  private readonly drive?:GoogleDriveRestMediaMaterializer;
  constructor(
    private readonly config:DistributionConfigurationStorePort,
    driveToken:AccessTokenProvider|null,
    driveCacheRoot:string
  ){
    if(driveToken)this.drive=new GoogleDriveRestMediaMaterializer(driveToken,{cacheRoot:driveCacheRoot});
  }

  async materialize(content:ContentItem):Promise<LocalMediaArtifact>{
    const connectionId=content.metadata.connectionId;
    if(!connectionId)throw new MediaMaterializationError(`Content ${content.contentId} has no source connectionId metadata`);
    const connection=this.config.load().config.sources.find((item)=>item.connectionId===connectionId);
    if(!connection)throw new MediaMaterializationError(`Content ${content.contentId} references unknown source ${connectionId}`);
    if(connection.kind==="local_folder"){
      if(!content.immutableMediaRef.startsWith("file://")&&!content.immutableMediaRef.startsWith("local://")){
        throw new MediaMaterializationError(`Local source ${connectionId} has incompatible media ref ${content.immutableMediaRef}`);
      }
      return await new LocalFileMediaMaterializer({allowedRoot:connection.rootRef}).materialize(content);
    }
    if(!content.immutableMediaRef.startsWith("gdrive://file/")){
      throw new MediaMaterializationError(`Drive source ${connectionId} has incompatible media ref ${content.immutableMediaRef}`);
    }
    if(!this.drive)throw new MediaMaterializationError(`Drive media materializer is not configured for workspace`);
    return await this.drive.materialize(content);
  }

  async release(artifact:LocalMediaArtifact):Promise<void>{
    if(artifact.sourceRef.startsWith("gdrive://file/"))await this.drive?.release(artifact);
  }
}
