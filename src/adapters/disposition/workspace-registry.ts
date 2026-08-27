import type { StoredDistributionConfiguration } from "../../domain/distribution-ports.js";
import type { SourceObservationLookupPort } from "../../domain/ingress-ports.js";
import type { AccessTokenProvider } from "../ingress/google-drive.js";
import { GoogleDriveAppPropertiesDispositionAdapter } from "./adapters.js";
import type { DistributionDispositionAdapterRegistry } from "./distribution-executor.js";
import { GoogleDriveRestWriteClient } from "./google-drive-rest.js";
import { LocalMoveDispositionAdapter, LocalSidecarDispositionAdapter } from "./local-files.js";

/**
 * Builds only provider/mutation combinations that have an explicit implementation.
 * Any unsupported combination is intentionally absent and therefore becomes MANUAL_REVIEW.
 */
export function buildWorkspaceDispositionAdapterRegistry(
  stored:StoredDistributionConfiguration,
  lookup:SourceObservationLookupPort,
  driveToken:AccessTokenProvider|null
):DistributionDispositionAdapterRegistry{
  const registry:Record<string,Record<string,import("../../domain/ports.js").SourceDispositionPort>>={};
  for(const connection of stored.config.sources){
    const adapters:Record<string,import("../../domain/ports.js").SourceDispositionPort>={};
    if(connection.kind==="google_drive"&&driveToken){
      adapters.WRITE_METADATA=new GoogleDriveAppPropertiesDispositionAdapter(lookup,new GoogleDriveRestWriteClient(driveToken));
    }
    if(connection.kind==="local_folder"){
      adapters.WRITE_SIDECAR=new LocalSidecarDispositionAdapter(lookup,connection.rootRef);
      if(connection.disposition.completedDestinationRef){adapters.MOVE=new LocalMoveDispositionAdapter(lookup,connection.rootRef,connection.disposition.completedDestinationRef);}
    }
    if(Object.keys(adapters).length>0)registry[connection.connectionId]=adapters;
  }
  return registry as DistributionDispositionAdapterRegistry;
}
