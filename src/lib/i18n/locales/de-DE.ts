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
    driverWarningTip: 'Derzeit im Kompatibilitätsmodus (70% KI-Leistung). Bitte aktualisieren Sie den Grafiktreiber für volle Leistung.',
    btnUpdateDriver: 'Grafiktreiber aktualisieren',
    btnRecheckDriver: 'Treiber aktualisiert, neu prüfen',
    vramBar: 'Geschätzte VRAM-Auslastung'
  },
  engine: {
    title: 'Lokale KI-Engine wechseln',
    desc: 'Ihre {vendor}-GPU unterstützt den Wechsel zu folgenden Engines',
    name: 'KI-Engine',
    type: 'Anpassungstyp',
    perfRating: 'Leistungsangabe',
    status: 'Status',
    action: 'Aktuelle Engine',
    statusReady: 'Bereit',
    statusActive: 'Wird ausgeführt',
    statusNotInstalled: 'Nicht installiert',
    statusDownloading: 'Wird heruntergeladen...',
    btnEnable: 'Engine wechseln',
    btnSwitch: 'Engine wechseln',
    btnActive: 'Aktuelle Engine',
    btnDownload: 'Engine herunterladen',
    btnUpdateDriver: 'Grafikkartentreiber aktualisieren',
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
    quantization: 'Quantisierung',
    intelLevel1: 'Grundschule',
    intelLevel2: 'Sekundarstufe I',
    intelLevel3: 'Gymnasium',
    intelLevel4: 'Universität'
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
  },
  chat: {
    tabTitle: 'Chatten Sie privat mit lokaler KI',
    notReadyTitle: 'Lokaler Inferenzdienst nicht bereit',
    notReadyDesc: 'Bitte starten Sie zuerst den lokalen KI-Engine-Dienst im Dashboard oder warten Sie, bis das Modell geladen ist.',
    btnStart: 'Dienst jetzt starten',
    openExternal: 'Im Browser öffnen',
    reload: 'Seite neu laden'
  },
  thinking: {
    title: 'Modelldenkenmodus',
    badgeTime: 'Wird den Zeitverbrauch erhöhen',
    desc: 'Nach dem Einschalten können lokale und Cloud-Modelle in den Denkmodus wechseln. Es wird empfohlen, diesen Modus nur bei Bedarf für Chats mit der KI zu aktivieren.',
    unsupportedTip: 'Modelle mit dem Tag „Instruct“ werden nicht unterstützt.'
  }
}
