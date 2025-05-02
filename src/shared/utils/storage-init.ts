// src/shared/utils/storage-init.ts (MODIFICADO CON PAUSA MÁS LARGA)
import { TableServiceClient, TableClient, RestError } from "@azure/data-tables";
import { QueueServiceClient, QueueClient } from "@azure/storage-queue";
import { BlobServiceClient, ContainerClient } from "@azure/storage-blob";
import { STORAGE_TABLES, STORAGE_QUEUES, BLOB_CONTAINERS } from "../constants";
import { Logger, createLogger } from "./logger";

// Función auxiliar para la pausa
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
// AUMENTAMOS EL TIEMPO DE ESPERA SIGNIFICATIVAMENTE
const WAIT_TIME_MS = 20000; // 20 segundos de espera (ajusta si es necesario)

export async function initializeStorage(forceReset: boolean = false, logger?: Logger): Promise<void> {
  console.log(">>> Función initializeStorage iniciada. forceReset =", forceReset);
  const log = logger || createLogger();
  log.info("=============================================");
  log.info("=== INICIALIZANDO/REINICIANDO ALMACENAMIENTO AZURE ===");
  log.info("=============================================");

  if (!forceReset) {
    log.warn("ADVERTENCIA: Ejecutando en modo seguro (forceReset=false). Solo se crearán recursos si no existen.");
    log.warn("Para eliminar y recrear todo, usa el flag --force al ejecutar o establece AZURE_STORAGE_FORCE_RESET=true.");
  } else {
    log.warn("*********************************************");
    log.warn("*** ¡ADVERTENCIA! MODO REINICIO ACTIVADO! ***");
    log.warn("*** SE ELIMINARÁN TODOS LOS DATOS EN:    ***");
    log.warn("*** - Tablas especificadas                ***");
    log.warn("*** - Colas especificadas                 ***");
    log.warn("*** - Contenedores Blob especificados     ***");
    log.warn("*********************************************");
    // Pausa inicial corta, la pausa principal es después de eliminar
    log.info("Esperando 5 segundos antes de continuar...");
    await sleep(5000);
    log.info("Continuando con el reinicio...");
  }

  try {
    const connectionString = process.env.AzureWebJobsStorage;
    console.log(">>> Valor de AzureWebJobsStorage:", connectionString ? connectionString.substring(0, 30) + '...' : 'INDEFINIDO');

    if (!connectionString) {
      throw new Error("No se ha configurado AzureWebJobsStorage en las variables de entorno");
    }
    log.info("Usando cadena de conexión de AzureWebJobsStorage.");

    // --- Inicializar Clientes ---
    const tableServiceClient = TableServiceClient.fromConnectionString(connectionString);
    const queueServiceClient = QueueServiceClient.fromConnectionString(connectionString);
    const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);

    // --- Reiniciar Tablas ---
    log.info("\n--- Procesando Tablas ---");
    const tables = Object.values(STORAGE_TABLES);
    for (const tableName of tables) {
      log.info(`Tabla: ${tableName}`);
      let deletedOrNotExists = false;

      if (forceReset) {
        try {
          log.warn(`  -> Eliminando tabla ${tableName}...`);
          await tableServiceClient.deleteTable(tableName);
          log.info(`  -> Tabla ${tableName} eliminada.`);
          deletedOrNotExists = true;
        } catch (error: any) {
          if ((error as RestError).statusCode === 404) {
            log.info(`  -> Tabla ${tableName} no existía.`);
            deletedOrNotExists = true;
          } else {
            log.error(`  -> Error al eliminar tabla ${tableName}:`, error.message);
          }
        }
        // Esperar SOLO si se intentó eliminar (y tuvo éxito o no existía)
        if (deletedOrNotExists) {
            log.info(`  -> Esperando ${WAIT_TIME_MS / 1000} seg después de eliminar/verificar ${tableName}...`);
            await sleep(WAIT_TIME_MS);
        }
      }

      try {
        log.info(`  -> Creando tabla ${tableName}...`);
        await tableServiceClient.createTable(tableName);
        log.info(`  -> Tabla ${tableName} creada.`);
      } catch (error: any) {
        if ((error as RestError).statusCode === 409) {
           log.info(`  -> Tabla ${tableName} ya existe.`);
        } else {
          log.error(`  -> Error al crear tabla ${tableName}:`, error.message);
        }
      }
    }

    // --- Reiniciar Colas ---
    log.info("\n--- Procesando Colas ---");
    const queues = Object.values(STORAGE_QUEUES);
    for (const queueName of queues) {
      log.info(`Cola: ${queueName}`);
      const queueClient = queueServiceClient.getQueueClient(queueName);
      let deletedOrNotExists = false;

      if (forceReset) {
        try {
          log.warn(`  -> Eliminando cola ${queueName}...`);
          const deleteResult = await queueClient.deleteIfExists();
          deletedOrNotExists = true; // Asumimos que se intentó, exista o no
          if (deleteResult.succeeded) {
             log.info(`  -> Cola ${queueName} eliminada.`);
          } else {
             log.info(`  -> Cola ${queueName} no existía.`);
          }
        } catch (error: any) {
           log.error(`  -> Error al eliminar cola ${queueName}:`, error.message);
        }
        // Esperar SOLO si se intentó eliminar
        if (deletedOrNotExists) {
            log.info(`  -> Esperando ${WAIT_TIME_MS / 1000} seg después de eliminar/verificar ${queueName}...`);
            await sleep(WAIT_TIME_MS);
        }
      }

      try {
        log.info(`  -> Creando cola ${queueName}...`);
        await queueClient.createIfNotExists();
        log.info(`  -> Cola ${queueName} creada/verificada.`);
      } catch (error: any) {
         log.error(`  -> Error al crear cola ${queueName}:`, error.message);
         // Podríamos reintentar aquí si el error es por "being deleted"
      }
    }

    // --- Reiniciar Contenedores Blob ---
    log.info("\n--- Procesando Contenedores Blob ---");
    const containers = Object.values(BLOB_CONTAINERS);
    for (const containerName of containers) {
       log.info(`Contenedor: ${containerName}`);
       const containerClient = blobServiceClient.getContainerClient(containerName);
       let deletedOrNotExists = false;

      if (forceReset) {
        try {
          log.warn(`  -> Eliminando contenedor ${containerName}...`);
          await containerClient.delete();
          log.info(`  -> Contenedor ${containerName} eliminado.`);
          deletedOrNotExists = true;
        } catch (error: any) {
          // @ts-ignore
          if (error.statusCode === 404) {
            log.info(`  -> Contenedor ${containerName} no existía.`);
            deletedOrNotExists = true;
          // @ts-ignore
          } else if (error.statusCode === 409 && error.details?.errorCode === 'ContainerBeingDeleted') {
             log.warn(`  -> Contenedor ${containerName} ya está siendo eliminado. Espera...`);
             deletedOrNotExists = true; // Aún así esperamos
          } else {
             log.error(`  -> Error al eliminar contenedor ${containerName}:`, error.message);
          }
        }
         // Esperar SOLO si se intentó eliminar
         if (deletedOrNotExists) {
             log.info(`  -> Esperando ${WAIT_TIME_MS / 1000} seg después de eliminar/verificar ${containerName}...`);
             await sleep(WAIT_TIME_MS);
         }
      }

      try {
        log.info(`  -> Creando contenedor ${containerName}...`);
        await containerClient.createIfNotExists();
        log.info(`  -> Contenedor ${containerName} creado/verificado.`);
      } catch (error: any) {
         log.error(`  -> Error al crear contenedor ${containerName}:`, error.message);
         // Podríamos reintentar aquí
      }
    }

    log.info("\n=============================================");
    log.info("=== Inicialización/Reinicio Completado ===");
    log.info("=============================================");

  } catch (error: any) {
    log.error("Error general durante la inicialización/reinicio del almacenamiento:", error);
    console.error(">>> ERROR CAPTURADO en bloque catch principal:", error);
    throw error;
  }
}

// --- Lógica para ejecutar desde línea de comandos (sin cambios) ---
async function runDirectly() {
    console.log(">>> Intentando ejecutar directamente...");
    try {
        const args = process.argv.slice(2);
        console.log(">>> Argumentos:", args);
        const forceEnv = process.env.AZURE_STORAGE_FORCE_RESET === 'true';
        console.log(">>> Variable de entorno AZURE_STORAGE_FORCE_RESET:", process.env.AZURE_STORAGE_FORCE_RESET, "(parsed as:", forceEnv, ")");
        const forceArg = args.includes('--force') || args.includes('-f');
        console.log(">>> Argumento --force encontrado:", forceArg);
        const shouldForce = forceArg || forceEnv;
        console.log(">>> Forzar reinicio:", shouldForce);

        if (!process.env.AzureWebJobsStorage) {
            console.error(">>> ERROR FATAL: La variable de entorno AzureWebJobsStorage no está definida.");
            process.exit(1);
        }

        await initializeStorage(shouldForce);

    } catch (err) {
        console.error(">>> Error en el bloque de ejecución directa:", err);
        process.exit(1);
    }
}

if (require.main === module) {
    console.log(">>> require.main === module es TRUE. Llamando a runDirectly()...");
    runDirectly();
} else {
    console.log(">>> require.main === module es FALSE. No se ejecuta directamente (importado como módulo).");
}