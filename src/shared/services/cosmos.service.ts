import {
  CosmosClient,
  Database,
  Container,
  ItemDefinition,
  CosmosClientOptions,
  FeedOptions,
} from "@azure/cosmos";

/**
 * Custom error class for handling Cosmos DB exceptions
 */
export class CosmosError extends Error {
  constructor(
    message: string,
    public code: number,
    public statusCode: number,
    public originalError?: any
  ) {
    super(message);
    this.name = "CosmosError";
  }
}

export interface QueryParameters {
  name: string;
  value: any;
}

/**
 * Service for interacting with Azure Cosmos DB
 * Handles CRUD operations and queries on containers
 */
export class CosmosService {
  private client: CosmosClient;
  private database: Database | null = null;
  private containers: Map<string, Container> = new Map();
  private readonly maxRetries = 3;
  private readonly retryDelay = 1000;

  constructor() {
    const endpoint = process.env.COSMOS_ENDPOINT || "";
    const key = process.env.COSMOS_KEY || "";

    if (!endpoint || !key) {
      throw new Error(
        "COSMOS_ENDPOINT and COSMOS_KEY are required in environment variables"
      );
    }

    const options: CosmosClientOptions = {
      endpoint,
      key,
    };

    this.client = new CosmosClient(options);
  }

  async disconnect(): Promise<void> {
    await this.client.dispose();
    this.containers.clear();
    this.database = null;
  }

  /**
   * Gets or creates a Cosmos DB container
   */
  async getContainer(containerName: string): Promise<Container> {
    if (this.containers.has(containerName)) {
      return this.containers.get(containerName)!;
    }

    if (!this.database) {
      const databaseName = process.env.COSMOS_DATABASE || "agentai-platform";
      const dbResponse = await this.client.databases.createIfNotExists({
        id: databaseName,
      });
      this.database = dbResponse.database;
    }

    const container = await this.database!.containers.createIfNotExists({
      id: containerName,
      partitionKey: { paths: ["/id"] },
    });

    this.containers.set(containerName, container.container);

    return container.container;
  }

  /**
   * Creates a new item in the specified container
   */
  async createItem<T extends ItemDefinition>(
    containerName: string,
    item: T
  ): Promise<T> {
    const container = await this.getContainer(containerName);
    const result = await container.items.create(item);
    return result.resource as unknown as T;
  }

  /**
   * Gets an item by its ID and partition key
   */
  async getItem<T extends ItemDefinition>(
    containerName: string,
    id: string,
    partitionKey: string
  ): Promise<T | null> {
    try {
      const container = await this.getContainer(containerName);
      const result = await container.item(id, partitionKey).read();
      return result.resource as unknown as T;
    } catch (error) {
      if ((error as any).code === 404) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Updates an existing item
   */
  async updateItem<T extends ItemDefinition>(
    containerName: string,
    id: string,
    partitionKey: string,
    item: T
  ): Promise<T> {
    const container = await this.getContainer(containerName);
    const result = await container.item(id, partitionKey).replace(item);
    return result.resource as unknown as T;
  }

  /**
   * Deletes an item by its ID and partition key
   */
  async deleteItem(
    containerName: string,
    id: string,
    partitionKey: string
  ): Promise<void> {
    const container = await this.getContainer(containerName);
    await container.item(id, partitionKey).delete();
  }

  /**
   * Executes a SQL query on the specified container
   */
  async queryItems<T>(
    containerName: string,
    query: string,
    parameters: QueryParameters[] = [],
    options: FeedOptions = {}
  ): Promise<T[]> {
    try {
      const container = await this.getContainer(containerName);
      const { resources } = await container.items
        .query({
          query,
          parameters,
          ...options,
        })
        .fetchAll();

      return resources as T[];
    } catch (error: any) {
      throw new CosmosError(
        `Error executing query in container ${containerName}: ${error.message}`,
        error.code,
        error.statusCode,
        error
      );
    }
  }

  /**
   * Retries a failed operation if the error is recoverable
   */
  private async retryOperation<T>(
    operation: () => Promise<T>,
    retryCount = 0
  ): Promise<T> {
    try {
      return await operation();
    } catch (error: any) {
      if (retryCount < this.maxRetries && this.isRetryableError(error)) {
        await new Promise((resolve) => setTimeout(resolve, this.retryDelay));
        return this.retryOperation(operation, retryCount + 1);
      }
      throw error;
    }
  }

  /**
   * Checks if an error is recoverable and should be retried
   */
  private isRetryableError(error: any): boolean {
    const retryableStatusCodes = [408, 429, 500, 502, 503, 504];
    return retryableStatusCodes.includes(error.statusCode);
  }
}
