# Nombre de la carpeta de destino para los archivos del núcleo del chatbot
$destFolder = "chatbot_nucleo_archivos"

# Lista de archivos a copiar (rutas relativas a la ubicación del script)
# Estos son los archivos identificados como clave para la lógica principal del chatbot.
$filesToCopy = @(
  "src/functions/conversation/MessageReceiver.ts",
  "src/shared/handlers/conversation/MessageReceiverHandler.ts",
  "src/functions/conversation/ChatCompletion.ts",
  "src/shared/handlers/conversation/ChatCompletionHandler.ts",
  "src/functions/conversation/ConversationHistory.ts",
  "src/shared/handlers/conversation/ConversationHistoryHandler.ts",
  "src/functions/conversation/ContextRetriever.ts",
  "src/shared/handlers/conversation/ContextRetrieverHandler.ts",
  "src/shared/models/conversation.model.ts",
  "src/shared/handlers/conversation/AdvancedWorkflowHandler.ts", # o IntelligentWorkflowHandler.ts si es más relevante
  "src/functions/integrations/GoogleCalendar.ts",
  "src/shared/handlers/integrations/GoogleCalendarHandler.ts",
  "src/shared/validators/integrations/googleCalendarValidator.ts",
  "src/shared/models/user.model.ts",
  "src/shared/handlers/auth/UserProfileHandler.ts",
  "src/index.ts",
  "src/shared/utils/logger.ts",
  "src/shared/utils/error.utils.ts",
  "src/functions/integrations/IntegrationExecutor.ts",
  "src/shared/handlers/integrations/IntegrationExecutorHandler.ts"
)

# Ruta completa de la carpeta de destino
# Se asume que este script se ejecuta en la raíz del proyecto donde se encuentra la carpeta 'src'
$projectRoot = $PSScriptRoot # Directorio donde se encuentra el script actual
# Si el script NO está en la raíz del proyecto, ajusta $projectRoot manualmente, por ejemplo:
# $projectRoot = "C:\ruta\a\tu\proyecto" # O usa Get-Location si ejecutas desde la raíz.

$fullDestPath = Join-Path -Path $projectRoot -ChildPath $destFolder

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
  $fullSourcePath = Join-Path -Path $projectRoot -ChildPath $filePath
  
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