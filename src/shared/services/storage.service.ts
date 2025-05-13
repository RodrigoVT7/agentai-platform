import { TableClient } from "@azure/data-tables";
import { BlobServiceClient, ContainerClient } from "@azure/storage-blob";
import { QueueServiceClient } from "@azure/storage-queue";

export class StorageService {
  private connectionString: string;

  constructor() {
    this.connectionString = process.env.STORAGE_CONNECTION_STRING || "";
  }

  getTableClient(tableName: string): TableClient {
    return TableClient.fromConnectionString(this.connectionString, tableName);
  }

  getBlobContainerClient(containerName: string): ContainerClient {
    const blobServiceClient = BlobServiceClient.fromConnectionString(
      this.connectionString
    );
    return blobServiceClient.getContainerClient(containerName);
  }

  getQueueClient(queueName: string): any {
    const queueServiceClient = QueueServiceClient.fromConnectionString(
      this.connectionString
    );
    return queueServiceClient.getQueueClient(queueName);
  }
}
