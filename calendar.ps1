# ===================================================================
# Script para Copiar Archivos de Integración de WhatsApp
# Autor: Gemini
# Descripción: Este script recopila todos los archivos clave
# involucrados en la conexión y comunicación con WhatsApp y
# los copia a una carpeta designada para su revisión.
# ===================================================================

# --- Configuración ---
# Nombre de la carpeta donde se copiarán los archivos.
$destFolder = "WhatsAppIntegrationAudit"

# Lista de rutas relativas de los archivos a copiar.
$filesToCopy = @(
    # --- Endpoints y Configuración Principal ---
    "src/functions/integrations/WhatsAppChannel.ts",
    "src/functions/integrations/MetaOAuth.ts",
    "src/functions/integrations/WhatsAppTemplateManager.ts",

    # --- Lógica de Negocio (Handlers) ---
    "src/shared/handlers/integrations/whatsAppIntegrationHandler.ts",
    "src/shared/handlers/integrations/whatsAppTemplateManagerHandler.ts",
    "src/shared/handlers/conversation/messageReceiverHandler.ts",
    "src/shared/handlers/conversation/messageSenderHandler.ts",
    
    # --- Servicios de Soporte ---
    "src/shared/services/metaPlatform.service.ts",

    # --- Validadores ---
    "src/shared/validators/integrations/whatsAppIntegrationValidator.ts",

    # --- Modelos de Datos y Constantes ---
    "src/shared/models/meta.model.ts",
    "src/shared/models/integration.model.ts",
    "src/shared/models/conversation.model.ts",
    "src/shared/constants/index.ts"
)

# --- Ejecución ---
# Obtener la ruta raíz del proyecto (asume que el script se ejecuta desde la raíz)
$projectRoot = Get-Location

# Construir la ruta completa de destino
$fullDestPath = Join-Path -Path $projectRoot -ChildPath $destFolder

Write-Host "-----------------------------------------------------"
Write-Host "Directorio de destino: $fullDestPath"
Write-Host "-----------------------------------------------------"

# Crear la carpeta de destino si no existe
if (-not (Test-Path -Path $fullDestPath -PathType Container)) {
    New-Item -ItemType Directory -Path $fullDestPath | Out-Null
    Write-Host "Carpeta '$destFolder' creada en '$projectRoot'."
} else {
    Write-Host "Carpeta '$destFolder' ya existe en '$projectRoot'."
}

# Copiar cada archivo
Write-Host "Iniciando copia de archivos a '$destFolder' (estructura plana)..."
foreach ($filePath in $filesToCopy) {
    # Reemplazar slashes para compatibilidad con Windows
    $normalizedFilePath = $filePath.Replace('/', '\')
    $fullSourcePath = Join-Path -Path $projectRoot -ChildPath $normalizedFilePath
    
    if (Test-Path -Path $fullSourcePath -PathType Leaf) {
        # Copiar directamente a la carpeta de destino, sin mantener estructura de subcarpetas
        Copy-Item -Path $fullSourcePath -Destination $fullDestPath
        $fileNameOnly = Split-Path -Path $fullSourcePath -Leaf
        Write-Host "Copiado: $fileNameOnly -> $fullDestPath"
    } else {
        Write-Warning "Archivo no encontrado - $filePath (ruta completa buscada: $fullSourcePath)"
    }
}

Write-Host "-----------------------------------------------------"
Write-Host "Proceso completado."
Write-Host "Los archivos seleccionados deberían estar en la carpeta: $fullDestPath"
Write-Host "Por favor, verifica la carpeta y los mensajes de advertencia si los hubiera."
