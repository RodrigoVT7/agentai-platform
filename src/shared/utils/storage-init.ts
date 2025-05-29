// src/shared/utils/storage-init.ts
import { TableServiceClient, TableClient, RestError } from "@azure/data-tables";
import { QueueServiceClient, QueueClient } from "@azure/storage-queue";
import { BlobServiceClient, ContainerClient } from "@azure/storage-blob";
import { STORAGE_TABLES, STORAGE_QUEUES, BLOB_CONTAINERS } from "../constants"; // Asegúrate que esta ruta es correcta
import { Logger, createLogger } from "./logger"; // Asegúrate que esta ruta es correcta
import * as fs from 'fs';
import * as path from 'path';

// Función auxiliar para la pausa
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
// AUMENTAMOS EL TIEMPO DE ESPERA SIGNIFICATIVAMENTE
const WAIT_TIME_MS = 20000; // 20 segundos de espera (ajusta si es necesario)

export async function initializeStorage(forceReset: boolean = false, logger?: Logger): Promise<void> {
  console.log(">>> Función initializeStorage iniciada. forceReset =", forceReset);
  const log = logger || createLogger(); // Crea un logger si no se proporciona uno
  log.info("=============================================");
  log.info("=== INICIALIZANDO/REINICIANDO ALMACENAMIENTO AZURE ===");
  log.info("=============================================");

  if (!forceReset) {
    log.warn("ADVERTENCIA: Ejecutando en modo seguro (forceReset=false). Solo se crearán recursos si no existen.");
    log.warn("Para eliminar y recrear todo, usa el flag --force al ejecutar o establece AZURE_STORAGE_FORCE_RESET=true.");
  } else {
    log.warn("*********************************************");
    log.warn("*** ¡ADVERTENCIA! MODO REINICIO ACTIVADO! ***");
    log.warn("*** SE ELIMINARÁN TODOS LOS DATOS EN:     ***");
    log.warn("*** - Tablas especificadas                ***");
    log.warn("*** - Colas especificadas                 ***");
    log.warn("*** - Contenedores Blob especificados     ***");
    log.warn("*********************************************");
    log.info(`Esperando 5 segundos antes de continuar...`);
    await sleep(5000); // Pausa inicial corta, la pausa principal es después de eliminar
    log.info("Continuando con el reinicio...");
  }

  try {
    const connectionString = process.env.AzureWebJobsStorage;
    console.log(">>> Valor de AzureWebJobsStorage:", connectionString ? connectionString.substring(0, 30) + '...' : 'INDEFINIDO');

    if (!connectionString) {
      throw new Error("No se ha configurado AzureWebJobsStorage en las variables de entorno. Asegúrate de que local.settings.json esté configurado y el script lo pueda leer, o que la variable de entorno esté definida globalmente.");
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
        if ((error as RestError).statusCode === 409) { // 409: Conflict (TableAlreadyExists)
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
          // @ts-ignore // Para acceder a statusCode y details.errorCode que pueden no estar tipados estrictamente
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
    console.error(">>> ERROR CAPTURADO en bloque catch principal de initializeStorage:", error);
    throw error; // Relanzar el error para que runDirectly() lo capture si es necesario
  }
}

// --- Lógica para ejecutar desde línea de comandos ---
async function runDirectly() {
  console.log(">>> Intentando ejecutar directamente el script de inicialización de almacenamiento...");
  try {
    // Intentar cargar local.settings.json si AzureWebJobsStorage no está en el entorno
    // Esto es crucial porque este script se ejecuta por fuera del entorno de `func start`
    if (!process.env.AzureWebJobsStorage) {
      console.log(">>> AzureWebJobsStorage no encontrado en process.env. Intentando cargar desde local.settings.json...");
      try {
        // Asumimos que el script se ejecuta desde la raíz del proyecto, o que process.cwd() es la raíz del proyecto.
        // Si local.settings.json está en la raíz del proyecto (junto a host.json)
        const localSettingsPath = path.resolve(process.cwd(), 'local.settings.json');

        if (fs.existsSync(localSettingsPath)) {
          const rawData = fs.readFileSync(localSettingsPath, 'utf8'); // Especificar encoding
          const settings = JSON.parse(rawData); // No es necesario .toString() si se especifica encoding

          if (settings.Values) {
            console.log(">>> local.settings.json cargado. Aplicando valores a process.env...");
            for (const key in settings.Values) {
              // Es importante setear AzureWebJobsStorage incluso si ya existe, para asegurar que viene de local.settings.json
              // Para otras variables, podrías decidir no sobrescribir: if (process.env[key] === undefined)
              process.env[key] = settings.Values[key];
            }
            if (settings.Values.AzureWebJobsStorage) {
              console.log(">>> AzureWebJobsStorage cargado desde local.settings.json.");
            } else {
              console.warn(">>> ADVERTENCIA: AzureWebJobsStorage no encontrado dentro de 'Values' en local.settings.json.");
            }
          } else {
            console.warn(">>> ADVERTENCIA: local.settings.json no contiene una sección 'Values'.");
          }
        } else {
          console.warn(`>>> ADVERTENCIA: local.settings.json no encontrado en la ruta: ${localSettingsPath}.`);
        }
      } catch (e: any) {
        console.error(">>> ERROR al cargar o parsear local.settings.json:", e.message);
        // Continuar de todas formas para que el chequeo posterior falle si es necesario.
      }
    }

    const args = process.argv.slice(2);
    console.log(">>> Argumentos de línea de comandos:", args);
    const forceEnv = process.env.AZURE_STORAGE_FORCE_RESET === 'true';
    console.log(">>> Variable de entorno AZURE_STORAGE_FORCE_RESET:", process.env.AZURE_STORAGE_FORCE_RESET, "(parseado como:", forceEnv, ")");
    const forceArg = args.includes('--force') || args.includes('-f');
    console.log(">>> Argumento --force/-f encontrado:", forceArg);
    const shouldForce = forceArg || forceEnv;
    console.log(">>> Forzar reinicio determinado:", shouldForce);

    // Este chequeo es ahora aún más importante
    if (!process.env.AzureWebJobsStorage) {
      console.error(">>> ERROR FATAL: La variable de entorno AzureWebJobsStorage no está definida.");
      console.error(">>> Asegúrate de que 'local.settings.json' exista en la raíz del proyecto con 'AzureWebJobsStorage' en 'Values',");
      console.error(">>> o que la variable de entorno AzureWebJobsStorage esté definida manualmente antes de ejecutar el script.");
      process.exit(1); // Salir con código de error
    }

    // Crear un logger para la ejecución directa si se desea logging más estructurado
    const directRunLogger = createLogger();
    await initializeStorage(shouldForce, directRunLogger);
    console.log(">>> Ejecución directa completada exitosamente.");

  } catch (err: any) { // Capturar cualquier error de initializeStorage o de la lógica de runDirectly
    console.error(">>> Error fatal en el bloque de ejecución directa (runDirectly):", err.message);
    if (err.stack) {
        console.error(err.stack);
    }
    process.exit(1); // Salir con código de error
  }
}

// Comprobar si el script se está ejecutando directamente
if (require.main === module) {
  console.log(">>> El script está siendo ejecutado directamente (require.main === module). Llamando a runDirectly()...");
  runDirectly();
} else {
  console.log(">>> El script está siendo importado como módulo (require.main !== module). No se ejecuta runDirectly() automáticamente.");
}