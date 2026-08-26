import type { AccessTokenProvider } from "../ingress/google-drive.js";
import type { GoogleDriveWriteClient } from "./adapters.js";

export class GoogleDriveRestWriteClient implements GoogleDriveWriteClient {
  constructor(
    private readonly tokenProvider: AccessTokenProvider,
    private readonly baseUrl = "https://www.googleapis.com/drive/v3"
  ) {}

  async setAppProperties(fileId: string, properties: Readonly<Record<string, string>>): Promise<void> {
    const token = await this.tokenProvider.getAccessToken();
    const response = await fetch(`${this.baseUrl}/files/${encodeURIComponent(fileId)}?supportsAllDrives=true`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ appProperties: properties })
    });
    if (!response.ok) throw new Error(`Google Drive appProperties update failed: HTTP ${response.status}`);
  }
}
