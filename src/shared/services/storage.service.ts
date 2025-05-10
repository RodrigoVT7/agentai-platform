import { TableClient, TableServiceClientOptions } from "@azure/data-tables";
import {
  BlobServiceClient,
  ContainerClient,
  StoragePipelineOptions as BlobPipelineOptions,
} from "@azure/storage-blob";
import {
  QueueServiceClient,
  StoragePipelineOptions as QueuePipelineOptions,
} from "@azure/storage-queue";
import { createLogger } from "../utils/logger";

export class StorageService {
  private connectionString: string;
  private readonly tableOptions: TableServiceClientOptions = {
    retryOptions: {
      maxRetries: 3,
      retryDelayInMs: 1000,
    },
    allowInsecureConnection: true,
  };
  private logger = createLogger();

  constructor() {
    this.connectionString = process.env.STORAGE_CONNECTION_STRING || "";
    if (!this.connectionString) {
      this.logger.error("STORAGE_CONNECTION_STRING no está configurada");
      throw new Error("STORAGE_CONNECTION_STRING no está configurada");
    }

    // Configurar NODE_TLS_REJECT_UNAUTHORIZED para desarrollo local
    if (process.env.AZURE_STORAGE_ALLOW_INSECURE === "true") {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
      this.logger.warn(
        "Se ha deshabilitado la verificación TLS para desarrollo local"
      );
    }
  }

  getTableClient(tableName: string): TableClient {
    try {
      return TableClient.fromConnectionString(
        this.connectionString,
        tableName,
        this.tableOptions
      );
    } catch (error) {
      this.logger.error(`Error al crear TableClient para ${tableName}:`, error);
      throw error;
    }
  }

  getBlobContainerClient(containerName: string): ContainerClient {
    try {
      const blobServiceClient = BlobServiceClient.fromConnectionString(
        this.connectionString
      );
      return blobServiceClient.getContainerClient(containerName);
    } catch (error) {
      this.logger.error(
        `Error al crear BlobContainerClient para ${containerName}:`,
        error
      );
      throw error;
    }
  }

  getQueueClient(queueName: string): any {
    try {
      const queueServiceClient = QueueServiceClient.fromConnectionString(
        this.connectionString
      );
      return queueServiceClient.getQueueClient(queueName);
    } catch (error) {
      this.logger.error(`Error al crear QueueClient para ${queueName}:`, error);
      throw error;
    }
  }
}
