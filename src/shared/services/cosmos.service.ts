import {
  CosmosClient,
  Database,
  Container,
  ItemDefinition,
} from "@azure/cosmos";

export class CosmosService {
  private client: CosmosClient;
  private database: Database | null = null;
  private containers: Map<string, Container> = new Map();

  constructor() {
    const endpoint = process.env.COSMOS_ENDPOINT || "";
    const key = process.env.COSMOS_KEY || "";

    if (!endpoint || !key) {
      console.warn(
        "ADVERTENCIA: COSMOS_ENDPOINT o COSMOS_KEY no están configurados en las variables de entorno"
      );
    }

    this.client = new CosmosClient({ endpoint, key });
  }

  async getContainer(containerName: string): Promise<Container> {
    // Si ya tenemos el contenedor en caché, lo devolvemos
    if (this.containers.has(containerName)) {
      return this.containers.get(containerName)!;
    }

    // Si no tenemos la base de datos, la obtenemos
    if (!this.database) {
      const databaseName = process.env.COSMOS_DATABASE || "agentai-platform";
      const dbResponse = await this.client.databases.createIfNotExists({
        id: databaseName,
      });
      this.database = dbResponse.database;
    }

    // Creamos el contenedor si no existe
    const container = await this.database!.containers.createIfNotExists({
      id: containerName,
      partitionKey: { paths: ["/id"] },
    });

    // Guardamos en caché
    this.containers.set(containerName, container.container);

    return container.container;
  }

  async createItem<T extends ItemDefinition>(
    containerName: string,
    item: T
  ): Promise<T> {
    const container = await this.getContainer(containerName);
    const result = await container.items.create(item);
    return result.resource as unknown as T;
  }

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

  async deleteItem(
    containerName: string,
    id: string,
    partitionKey: string
  ): Promise<void> {
    const container = await this.getContainer(containerName);
    await container.item(id, partitionKey).delete();
  }

  async queryItems<T>(
    containerName: string,
    query: string,
    parameters: any[] = []
  ): Promise<T[]> {
    const container = await this.getContainer(containerName);
    const { resources } = await container.items
      .query({
        query,
        parameters,
      })
      .fetchAll();

    return resources as T[];
  }
}
