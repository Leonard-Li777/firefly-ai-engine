import { TranslationKeys } from './zh-CN'

export const deDE: TranslationKeys = {
  app: {
    title: 'Firefly AI Engine',
    subtitle: 'Eigenständige On-Device KI-Inferenz-Engine & Modellverwaltungsplattform',
    language: 'Sprache'
  },
  network: {
    detecting: 'Netzwerkumgebung wird ermittelt...',
    mirrorCn: 'CN-Beschleunigungsspiegel (ModelScope / Schneller Proxy)',
    directGlobal: 'Globaler Direktzugriff (HuggingFace / Offiziell)',
    probeSuccess: 'Netzwerkerkennung abgeschlossen'
  },
  hardware: {
    title: 'Hardware-Umgebung & Treiberdiagnose',
    gpuModel: 'Grafikkartenmodell (GPU)',
    vram: 'Verfügbarer VRAM',
    totalMem: 'System-RAM',
    activeBackend: 'Aktives Backend',
    recommendedBackend: 'Empfohlenes Backend',
    driverWarningTitle: 'Treiberwarnung & automatische Downgrade-Diagnose',
    driverWarningTip: 'Die NVIDIA-Treiberversion ist zu alt oder es fehlt CUDA-Unterstützung. Automatisch auf Vulkan zurückgestuft. Eine Aktualisierung des Grafiktreibers wird dringend empfohlen.',
    vramBar: 'Geschätzte VRAM-Auslastung'
  },
  engine: {
    title: 'KI-Rechen-Engines & Umschaltung',
    desc: 'Unterstützt Vulkan, CPU, CUDA 12.4 und Metal-Laufzeiten mit nahtloser Direktumschaltung.',
    name: 'Engine-Name',
    type: 'Backend-Architektur',
    status: 'Status',
    action: 'Aktion',
    statusReady: 'Bereit',
    statusActive: 'Wird ausgeführt',
    statusNotInstalled: 'Nicht installiert',
    statusDownloading: 'Wird heruntergeladen...',
    btnEnable: 'Aktivieren',
    btnActive: 'Aktiv',
    btnDownload: 'Herunterladen',
    switchSuccess: 'Engine erfolgreich umgeschaltet',
    downloadFailed: 'Download der Engine fehlgeschlagen'
  },
  storage: {
    title: 'Benutzerdefiniertes Modell-Speicherverzeichnis',
    desc: 'Speicherort auf Partitionen mit viel freiem Speicherplatz anpassen. Eine Änderung scannt sofort nach GGUF-Modellen.',
    currentPath: 'Aktueller Speicherpfad',
    btnBrowse: 'Durchsuchen',
    btnRescan: 'Erneut scannen',
    scanning: 'Modelle werden gescannt...',
    scanSuccess: 'Scan abgeschlossen, {count} Modelle gefunden'
  },
  models: {
    title: 'On-Device-Modelle & Orchestrierung',
    tabInstalled: 'Installiert ({count})',
    tabRecommended: 'Empfohlen ({count})',
    searchPlaceholder: 'Modellname, Organisation oder Spezifikation suchen...',
    sourceFilter: 'Quellenkanal',
    sourceAll: 'Alle Quellen',
    sourceModelScope: 'ModelScope (CN)',
    sourceHuggingFace: 'HuggingFace (Global)',
    sourceLocal: 'Lokaler Import',
    emptyInstalled: 'Noch keine Modelle installiert. Wählen Sie Herunterladen aus der Liste.',
    emptyRecommended: 'Keine passenden empfohlenen Modelle gefunden',
    btnDownload: 'Herunterladen',
    btnDownloading: 'Wird geladen...',
    btnRun: 'Engine starten',
    btnRunning: 'Wird ausgeführt',
    btnStop: 'Engine anhalten',
    tagMultimodal: 'Multimodale Vision',
    tagDspark: 'DSpark Spekulativ',
    tagCpuFriendly: 'CPU-Freundlich',
    tagRecommended: 'Empfohlen',
    paramSize: 'Parameter',
    fileSize: 'Dateigröße',
    vramNeeded: 'VRAM-Bedarf',
    quantization: 'Quantisierung'
  },
  runtime: {
    title: 'Laufzeitüberwachung & sichere Planung',
    desc: 'Echtzeit-Parameteranpassung nach dem Sicherheitsprinzip ubatch <= batch und Max-Fill VRAM-Offloading.',
    gpuLayers: 'GPU-Offload-Schichten (-ngl)',
    batchSize: 'Batch-Größe (--batch-size)',
    ubatchSize: 'Mikro-Batch-Größe (--ubatch-size)',
    threads: 'CPU-Rechenthreads (-t)',
    ctxSize: 'Kontextfenstergröße (--ctx-size)',
    vramAllocation: 'Dynamische VRAM-Schätzung',
    flashAttention: 'Flash Attention',
    faEnabled: 'Aktiviert (Hardware unterstützt)',
    faDisabled: 'Deaktiviert (Vulkan / CPU / Fallback)'
  },
  common: {
    success: 'Vorgang erfolgreich',
    failed: 'Vorgang fehlgeschlagen',
    loading: 'Wird geladen...',
    confirm: 'Bestätigen',
    cancel: 'Abbrechen'
  }
}
