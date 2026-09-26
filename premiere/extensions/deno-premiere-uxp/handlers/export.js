const { storage } = require("uxp");
const { BridgeError } = require("./errors.js");
const {
  booleanArg,
  enumArg,
  findSequence,
  getActiveProject,
  numberArg,
  ppro,
  rejectUnknown,
  requireClipProjectItem,
  secondsOf,
  stringArg,
  tickTimeFromSeconds,
  validateNoArgs
} = require("./shared.js");

function validateExportSequence(args) {
  rejectUnknown(args, [
    "output_path",
    "preset_path",
    "work_area_only",
    "destination"
  ]);
  return {
    output_path: stringArg(args.output_path, "output_path"),
    preset_path: stringArg(args.preset_path, "preset_path", {
      optional: true,
      fallback: undefined
    }),
    work_area_only: booleanArg(args.work_area_only, "work_area_only", {
      optional: true,
      fallback: false
    }),
    destination: enumArg(
      args.destination,
      "destination",
      ["immediate", "ame", "app"],
      { optional: true, fallback: "immediate" }
    )
  };
}

function validateRenderQueue(args) {
  rejectUnknown(args, ["output_path", "preset_path", "work_area_only"]);
  return {
    output_path: stringArg(args.output_path, "output_path", {
      optional: true,
      fallback: undefined
    }),
    preset_path: stringArg(args.preset_path, "preset_path", {
      optional: true,
      fallback: undefined
    }),
    work_area_only: booleanArg(args.work_area_only, "work_area_only", {
      optional: true,
      fallback: false
    })
  };
}

function validateExportFrame(args) {
  rejectUnknown(args, ["output_path", "time_seconds"]);
  return {
    output_path: stringArg(args.output_path, "output_path"),
    time_seconds:
      args.time_seconds === undefined
        ? undefined
        : numberArg(args.time_seconds, "time_seconds", { min: 0 })
  };
}

function validateOutputPath(args) {
  rejectUnknown(args, ["output_path"]);
  return { output_path: stringArg(args.output_path, "output_path") };
}

function absoluteFilePath(value, name, extension) {
  const candidate = stringArg(value, name);
  if (candidate.includes("\0")) {
    throw new BridgeError(
      "INVALID_ARGUMENTS",
      `${name}에 NUL 문자를 사용할 수 없습니다.`
    );
  }
  const normalized = candidate.replace(/\\/g, "/");
  const absolute =
    /^[A-Za-z]:\//.test(normalized) ||
    /^\/\/[^/]+\//.test(normalized) ||
    normalized.startsWith("/");
  const slash = normalized.lastIndexOf("/");
  if (!absolute || slash < 0 || slash === normalized.length - 1) {
    throw new BridgeError(
      "INVALID_ARGUMENTS",
      `${name}은 디렉터리와 파일명을 포함한 절대 경로여야 합니다.`
    );
  }
  if (extension && !normalized.toLocaleLowerCase().endsWith(extension)) {
    throw new BridgeError(
      "INVALID_ARGUMENTS",
      `${name}은 ${extension} 파일이어야 합니다.`
    );
  }
  return candidate;
}

function validateAaf(args) {
  rejectUnknown(args, [
    "output_path",
    "mix_down_video",
    "explode_to_mono",
    "sample_rate",
    "bits_per_sample",
    "embed_audio",
    "audio_file_format",
    "trim_sources",
    "handle_frames",
    "video_mixdown_preset_path",
    "render_audio_effects",
    "interleave_without_effects",
    "preserve_parent_folder"
  ]);
  const videoMixdownPresetPath =
    args.video_mixdown_preset_path === undefined
      ? undefined
      : absoluteFilePath(
          args.video_mixdown_preset_path,
          "video_mixdown_preset_path",
          ".epr"
        );
  return {
    output_path: absoluteFilePath(args.output_path, "output_path", ".aaf"),
    mix_down_video: booleanArg(args.mix_down_video, "mix_down_video", {
      optional: true,
      fallback: true
    }),
    explode_to_mono: booleanArg(args.explode_to_mono, "explode_to_mono", {
      optional: true,
      fallback: false
    }),
    sample_rate: numberArg(args.sample_rate, "sample_rate", {
      optional: true,
      fallback: 48000,
      integer: true,
      min: 8000,
      max: 384000
    }),
    bits_per_sample: numberArg(args.bits_per_sample, "bits_per_sample", {
      optional: true,
      fallback: 16,
      integer: true,
      min: 8,
      max: 32
    }),
    embed_audio: booleanArg(args.embed_audio, "embed_audio", {
      optional: true,
      fallback: undefined
    }),
    audio_file_format: enumArg(
      args.audio_file_format,
      "audio_file_format",
      ["aiff", "wav"],
      { optional: true, fallback: undefined }
    ),
    trim_sources: booleanArg(args.trim_sources, "trim_sources", {
      optional: true,
      fallback: undefined
    }),
    handle_frames: numberArg(args.handle_frames, "handle_frames", {
      optional: true,
      fallback: undefined,
      integer: true,
      min: 0,
      max: 1000000
    }),
    video_mixdown_preset_path: videoMixdownPresetPath,
    render_audio_effects: booleanArg(
      args.render_audio_effects,
      "render_audio_effects",
      { optional: true, fallback: undefined }
    ),
    interleave_without_effects: booleanArg(
      args.interleave_without_effects,
      "interleave_without_effects",
      { optional: true, fallback: undefined }
    ),
    preserve_parent_folder: booleanArg(
      args.preserve_parent_folder,
      "preserve_parent_folder",
      { optional: true, fallback: undefined }
    )
  };
}

function validateEncodeItem(args) {
  rejectUnknown(args, [
    "item_id",
    "output_path",
    "preset_path",
    "remove_on_completion",
    "start_queue_immediately"
  ]);
  return {
    item_id: stringArg(args.item_id, "item_id"),
    output_path: stringArg(args.output_path, "output_path"),
    preset_path: stringArg(args.preset_path, "preset_path"),
    remove_on_completion: booleanArg(
      args.remove_on_completion,
      "remove_on_completion",
      { optional: true, fallback: true }
    ),
    start_queue_immediately: booleanArg(
      args.start_queue_immediately,
      "start_queue_immediately",
      { optional: true, fallback: true }
    )
  };
}

function validateEncodeFile(args) {
  rejectUnknown(args, [
    "input_path",
    "output_path",
    "preset_path",
    "in_seconds",
    "out_seconds",
    "remove_on_completion",
    "start_queue_immediately"
  ]);
  const inSeconds =
    args.in_seconds === undefined
      ? undefined
      : numberArg(args.in_seconds, "in_seconds", { min: 0 });
  const outSeconds =
    args.out_seconds === undefined
      ? undefined
      : numberArg(args.out_seconds, "out_seconds", { min: 0 });
  if (inSeconds !== undefined && outSeconds !== undefined && outSeconds <= inSeconds) {
    throw new BridgeError("INVALID_ARGUMENTS", "out_seconds는 in_seconds보다 커야 합니다.");
  }
  return {
    input_path: stringArg(args.input_path, "input_path"),
    output_path: stringArg(args.output_path, "output_path"),
    preset_path: stringArg(args.preset_path, "preset_path"),
    in_seconds: inSeconds,
    out_seconds: outSeconds,
    remove_on_completion: booleanArg(
      args.remove_on_completion,
      "remove_on_completion",
      { optional: true, fallback: true }
    ),
    start_queue_immediately: booleanArg(
      args.start_queue_immediately,
      "start_queue_immediately",
      { optional: true, fallback: true }
    )
  };
}

function validateEncoderXmpOptions(args) {
  rejectUnknown(args, ["embedded_enabled", "sidecar_enabled"]);
  const embeddedEnabled = booleanArg(
    args.embedded_enabled,
    "embedded_enabled",
    { optional: true, fallback: undefined }
  );
  const sidecarEnabled = booleanArg(args.sidecar_enabled, "sidecar_enabled", {
    optional: true,
    fallback: undefined
  });
  if (embeddedEnabled === undefined && sidecarEnabled === undefined) {
    throw new BridgeError(
      "INVALID_ARGUMENTS",
      "embedded_enabled 또는 sidecar_enabled 중 하나는 필요합니다."
    );
  }
  return {
    embedded_enabled: embeddedEnabled,
    sidecar_enabled: sidecarEnabled
  };
}

function validateEncoderEvents(args) {
  rejectUnknown(args, ["after_event_id", "job_id", "limit"]);
  return {
    after_event_id: numberArg(args.after_event_id, "after_event_id", {
      optional: true,
      fallback: 0,
      integer: true,
      min: 0
    }),
    job_id: stringArg(args.job_id, "job_id", {
      optional: true,
      fallback: undefined
    }),
    limit: numberArg(args.limit, "limit", {
      optional: true,
      fallback: 100,
      integer: true,
      min: 1,
      max: 200
    })
  };
}

function validatePreset(args) {
  rejectUnknown(args, ["preset_path"]);
  return { preset_path: stringArg(args.preset_path, "preset_path") };
}

function validateCapture(args) {
  rejectUnknown(args, ["time_seconds"]);
  return {
    time_seconds:
      args.time_seconds === undefined
        ? undefined
        : numberArg(args.time_seconds, "time_seconds", { min: 0 })
  };
}

function splitOutputPath(outputPath) {
  const normalized = String(outputPath).replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  if (slash < 1 || slash === normalized.length - 1) {
    throw new BridgeError(
      "INVALID_ARGUMENTS",
      "output_path는 디렉터리와 파일명을 포함한 절대 경로여야 합니다."
    );
  }
  return {
    fullPath: normalized,
    directory: normalized.slice(0, slash + 1),
    basename: normalized.slice(slash + 1)
  };
}

async function frameExport(sequence, time, outputPath, dimensions) {
  const parts = splitOutputPath(outputPath);
  const frameSize = dimensions || (await sequence.getFrameSize());
  const width = Number(frameSize.width);
  const height = Number(frameSize.height);
  const callDetails = {
    filename: parts.fullPath,
    filepath: parts.directory,
    basename: parts.basename,
    width,
    height
  };
  let exported;
  try {
    // premierepro.d.ts documents filename as the full output file path and
    // filepath as its directory. capture_frame has a temporary runtime
    // strategy ladder below because the 26.3 binding has disagreed with mocks.
    exported = await ppro().Exporter.exportSequenceFrame(
      sequence,
      time,
      parts.fullPath,
      parts.directory,
      width,
      height
    );
  } catch (error) {
    throw new BridgeError(
      "FRAME_EXPORT_FAILED",
      "Frame export failed",
      {
        ...callDetails,
        cause: String((error && (error.message || error)) || "알 수 없는 오류")
      }
    );
  }
  if (!exported) {
    throw new BridgeError("FRAME_EXPORT_FAILED", "Frame export failed", {
      ...callDetails,
      cause: "Exporter.exportSequenceFrame() returned false"
    });
  }
  return { path: outputPath, width, height };
}

function runtimeShape(value) {
  let constructorName = null;
  try {
    constructorName =
      value && value.constructor && typeof value.constructor.name === "string"
        ? value.constructor.name
        : null;
  } catch (_error) {
    constructorName = null;
  }
  return {
    type: typeof value,
    constructorName,
    isPromise: Boolean(value && typeof value.then === "function")
  };
}

function finiteFrameSize(rect) {
  const width = Number(rect && rect.width);
  const height = Number(rect && rect.height);
  return Number.isFinite(width) &&
    width > 0 &&
    Number.isFinite(height) &&
    height > 0
    ? { width: Math.round(width), height: Math.round(height) }
    : null;
}

async function readSequenceFrameSize(sequence) {
  try {
    const settings = await sequence.getSettings();
    if (settings && typeof settings.getVideoFrameRect === "function") {
      const fromSettings = finiteFrameSize(await settings.getVideoFrameRect());
      if (fromSettings) {
        return {
          ...fromSettings,
          source: "sequence.getSettings().getVideoFrameRect"
        };
      }
    }
  } catch (_error) {
    // Fall back to Sequence.getFrameSize(), also documented in premierepro.d.ts.
  }

  const fromSequence = finiteFrameSize(await sequence.getFrameSize());
  if (!fromSequence) {
    throw new BridgeError(
      "FRAME_SIZE_UNAVAILABLE",
      "시퀀스의 실제 프레임 크기를 읽을 수 없습니다."
    );
  }
  return { ...fromSequence, source: "sequence.getFrameSize" };
}

function capturePathVariants(nativeDirectory, basename) {
  const withoutTrailing = String(nativeDirectory || "").replace(/[\\/]+$/, "");
  if (!withoutTrailing) {
    throw new BridgeError(
      "CAPTURE_DIRECTORY_UNAVAILABLE",
      "UXP captures 폴더의 nativePath를 읽을 수 없습니다."
    );
  }
  const backslashDirectory = withoutTrailing.replace(/\//g, "\\");
  const slashDirectory = withoutTrailing.replace(/\\/g, "/");
  return [
    {
      id: "full_path_backslash_trailing_dir",
      filename: `${backslashDirectory}\\${basename}`,
      filepath: `${backslashDirectory}\\`
    },
    {
      id: "full_path_slash_trailing_dir",
      filename: `${slashDirectory}/${basename}`,
      filepath: `${slashDirectory}/`
    },
    {
      id: "basename_slash_dir_no_trailing",
      filename: basename,
      filepath: slashDirectory
    },
    {
      id: "basename_slash_dir_trailing",
      filename: basename,
      filepath: `${slashDirectory}/`
    }
  ];
}

function byteLengthOf(value) {
  if (value === null || value === undefined) return null;
  if (Number.isFinite(Number(value.byteLength))) return Number(value.byteLength);
  if (Number.isFinite(Number(value.length))) return Number(value.length);
  return null;
}

async function inspectCaptureEntryOnce(folder, basename) {
  let entry;
  try {
    entry = await folder.getEntry(basename);
  } catch (error) {
    return {
      entry: null,
      diagnostic: {
        exists: false,
        isFile: false,
        size: 0,
        inspectionError: String((error && (error.message || error)) || "not found")
      }
    };
  }

  let size = null;
  let inspectionError = null;
  try {
    if (entry && typeof entry.getMetadata === "function") {
      const metadata = await entry.getMetadata();
      size = Number(metadata && metadata.size);
    }
    if ((!Number.isFinite(size) || size < 0) && entry && typeof entry.read === "function") {
      const binaryFormat = storage.formats && storage.formats.binary;
      const contents = binaryFormat
        ? await entry.read({ format: binaryFormat })
        : await entry.read();
      size = byteLengthOf(contents);
    }
  } catch (error) {
    inspectionError = String(
      (error && (error.message || error)) || "파일 크기 확인 실패"
    );
  }

  return {
    entry,
    diagnostic: {
      exists: true,
      isFile: Boolean(entry && entry.isFile === true),
      size: Number.isFinite(size) && size >= 0 ? size : null,
      ...(inspectionError ? { inspectionError } : {})
    }
  };
}

async function inspectCaptureEntry(folder, basename) {
  let inspected = null;
  for (let check = 1; check <= 3; check += 1) {
    inspected = await inspectCaptureEntryOnce(folder, basename);
    inspected.diagnostic.checkCount = check;
    if (
      inspected.diagnostic.exists &&
      inspected.diagnostic.isFile &&
      Number(inspected.diagnostic.size) > 0
    ) {
      break;
    }
    if (check < 3) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  return inspected;
}

async function removeFailedCaptureEntry(entry) {
  if (!entry || typeof entry.delete !== "function") return;
  try {
    await entry.delete();
  } catch (_error) {
    // Failed diagnostic files live in PluginData/captures and are temporary.
  }
}

function captureStrategies(nativeDirectory, basename, previewSize, sequenceSize) {
  const pathVariants = capturePathVariants(nativeDirectory, basename);
  const dimensionVariants = [
    { id: "preview_size", width: previewSize.width, height: previewSize.height },
    { id: "sequence_size", width: sequenceSize.width, height: sequenceSize.height }
  ];
  const result = [];
  for (const dimensions of dimensionVariants) {
    for (const pathVariant of pathVariants) {
      result.push({
        name: `${pathVariant.id}_${dimensions.id}`,
        pathVariant: pathVariant.id,
        dimensionVariant: dimensions.id,
        filename: pathVariant.filename,
        filepath: pathVariant.filepath,
        width: dimensions.width,
        height: dimensions.height
      });
    }
  }
  return result;
}

async function captureFrameWithStrategies(options) {
  const { sequence, time, folder, basename, previewSize, sequenceSize } = options;
  const attempts = [];
  const nativeDirectory = String(folder.nativePath || "").replace(/[\\/]+$/, "");
  const outputPath = `${nativeDirectory}\\${basename}`;

  // TODO: 실기기에서 정답이 확정되면 진단 사다리를 단일 경로로 정리한다.
  for (const strategy of captureStrategies(
    nativeDirectory,
    basename,
    previewSize,
    sequenceSize
  )) {
    const meta = {
      pathVariant: strategy.pathVariant,
      dimensionVariant: strategy.dimensionVariant,
      filename: strategy.filename,
      filepath: strategy.filepath,
      basename,
      width: strategy.width,
      height: strategy.height,
      frameSizeSource: sequenceSize.source
    };
    let exportedValue = null;
    let exportError = null;
    try {
      exportedValue = await ppro().Exporter.exportSequenceFrame(
        sequence,
        time,
        strategy.filename,
        strategy.filepath,
        strategy.width,
        strategy.height
      );
      const shape = runtimeShape(exportedValue);
      meta.exportReturnType = shape.type;
      meta.exportReturnConstructorName = shape.constructorName;
      meta.exportReturnIsPromise = shape.isPromise;
      meta.exportReturned = exportedValue;
    } catch (error) {
      exportError = String(
        (error && (error.message || error)) || "Exporter 호출 실패"
      );
      meta.exportError = exportError;
    }

    const inspected = await inspectCaptureEntry(folder, basename);
    meta.file = inspected.diagnostic;
    const usable =
      inspected.diagnostic.exists &&
      inspected.diagnostic.isFile &&
      Number(inspected.diagnostic.size) > 0;

    if (usable) {
      attempts.push({ strategy: strategy.name, ok: true, meta });
      return {
        path: outputPath,
        width: strategy.width,
        height: strategy.height,
        attempts,
        strategyUsed: strategy.name
      };
    }

    const reasons = [];
    if (exportError) reasons.push(exportError);
    else if (!exportedValue) {
      reasons.push("Exporter.exportSequenceFrame() returned false");
    }
    if (!inspected.diagnostic.exists) reasons.push("output file was not created");
    else if (!inspected.diagnostic.isFile) reasons.push("output entry is not a file");
    else if (!(Number(inspected.diagnostic.size) > 0)) {
      reasons.push("output file size is zero or unavailable");
    }
    attempts.push({
      strategy: strategy.name,
      ok: false,
      error: reasons.join("; ") || "capture strategy failed",
      meta
    });
    await removeFailedCaptureEntry(inspected.entry);
  }

  throw new BridgeError(
    "FRAME_EXPORT_FAILED",
    "모든 capture_frame 내보내기 전략이 실패했습니다.",
    {
      attempts,
      strategyUsed: null,
      previewDimensions: { width: previewSize.width, height: previewSize.height },
      sequenceDimensions: {
        width: sequenceSize.width,
        height: sequenceSize.height,
        source: sequenceSize.source
      }
    }
  );
}

async function exportSequence(args) {
  const project = await getActiveProject();
  const sequence = await findSequence(project);
  const manager = ppro().EncoderManager.getManager();
  ensureEncoderEventJournal(manager);
  const exportTypes = {
    immediate: ppro().Constants.ExportType.IMMEDIATELY,
    ame: ppro().Constants.ExportType.QUEUE_TO_AME,
    app: ppro().Constants.ExportType.QUEUE_TO_APP
  };
  const exported = await manager.exportSequence(
    sequence,
    exportTypes[args.destination],
    args.output_path,
    args.preset_path,
    !args.work_area_only
  );
  if (!exported) throw new BridgeError("EXPORT_FAILED", "Sequence export failed to start");
  return {
    started: true,
    destination: args.destination,
    outputPath: args.output_path,
    workAreaOnly: args.work_area_only,
    undoable: false
  };
}

async function addToRenderQueue(args) {
  const project = await getActiveProject();
  const sequence = await findSequence(project);
  const manager = ppro().EncoderManager.getManager();
  ensureEncoderEventJournal(manager);
  const queued = await manager.exportSequence(
    sequence,
    ppro().Constants.ExportType.QUEUE_TO_AME,
    args.output_path,
    args.preset_path,
    !args.work_area_only
  );
  if (!queued) {
    throw new BridgeError("EXPORT_FAILED", "AME render queue submission failed");
  }
  return {
    queued: true,
    destination: "ame",
    outputPath: args.output_path,
    presetPath: args.preset_path,
    workAreaOnly: args.work_area_only,
    undoable: false
  };
}

async function exportFrame(args) {
  const project = await getActiveProject();
  const sequence = await findSequence(project);
  const time =
    args.time_seconds === undefined
      ? await sequence.getPlayerPosition()
      : tickTimeFromSeconds(args.time_seconds);
  const result = await frameExport(sequence, time, args.output_path);
  return { exported: true, ...result, timeSeconds: secondsOf(time), undoable: false };
}

async function exportAsFcpXml(args) {
  const project = await getActiveProject();
  const sequence = await findSequence(project);
  const exported = await ppro().ProjectConverter.exportAsFinalCutProXML(
    sequence,
    args.output_path,
    true
  );
  if (!exported) throw new BridgeError("EXPORT_FAILED", "FCP XML export failed");
  return { exported: true, outputPath: args.output_path, undoable: false };
}

function applyAafOption(options, methodName, value) {
  if (!options || typeof options[methodName] !== "function") {
    throw new BridgeError(
      "AAF_OPTION_UNAVAILABLE",
      `Premiere UXP AAFExportOptions.${methodName} API를 사용할 수 없습니다.`
    );
  }
  const configured = options[methodName](value);
  if (!configured) {
    throw new BridgeError(
      "AAF_OPTION_REJECTED",
      `AAFExportOptions.${methodName}()이 옵션을 반환하지 않았습니다.`
    );
  }
  return configured;
}

function aafOptionsSnapshot(options, audioFileFormatName) {
  const audioFileFormatValue = Number(options.audioFileFormat);
  const resolvedAudioFileFormatName =
    audioFileFormatName ||
    (audioFileFormatValue === ppro().Constants.AAFExportAudioFormat.AIFF
      ? "aiff"
      : audioFileFormatValue === ppro().Constants.AAFExportAudioFormat.WAV
        ? "wav"
        : null);
  return {
    mixDownVideo: Boolean(options.mixdownVideo),
    explodeToMono: Boolean(options.explodeToMono),
    sampleRate: Number(options.sampleRate),
    bitsPerSample: Number(options.bitsPerSample),
    embedAudio: Boolean(options.embedAudio),
    audioFileFormat: resolvedAudioFileFormatName,
    audioFileFormatValue,
    trimSources: Boolean(options.trimSources),
    handleFrames: Number(options.handleFrames),
    videoMixdownPresetPath: String(options.videoMixdownPresetPath || ""),
    renderAudioEffects: Boolean(options.renderAudioEffects),
    interleaveWithoutEffects: Boolean(options.interleaveWithoutEffects),
    preserveParentFolder: Boolean(options.preserveParentFolder)
  };
}

async function exportAaf(args) {
  const project = await getActiveProject();
  const sequence = await findSequence(project);
  let options = new (ppro().AAFExportOptions)();
  options = applyAafOption(options, "setMixdownVideo", args.mix_down_video);
  options = applyAafOption(options, "setExplodeToMono", args.explode_to_mono);
  options = applyAafOption(options, "setSampleRate", args.sample_rate);
  options = applyAafOption(options, "setBitsPerSample", args.bits_per_sample);

  if (args.embed_audio !== undefined) {
    options = applyAafOption(options, "setEmbedAudio", args.embed_audio);
  }
  if (args.audio_file_format !== undefined) {
    const formatConstants = ppro().Constants.AAFExportAudioFormat;
    const formatValue =
      args.audio_file_format === "aiff"
        ? formatConstants && formatConstants.AIFF
        : formatConstants && formatConstants.WAV;
    if (formatValue === undefined) {
      throw new BridgeError(
        "AAF_OPTION_UNAVAILABLE",
        "Premiere UXP AAFExportAudioFormat 상수를 사용할 수 없습니다."
      );
    }
    options = applyAafOption(options, "setAudioFileFormat", formatValue);
  }
  if (args.trim_sources !== undefined) {
    options = applyAafOption(options, "setTrimSources", args.trim_sources);
  }
  if (args.handle_frames !== undefined) {
    options = applyAafOption(options, "setHandleFrames", args.handle_frames);
  }
  if (args.video_mixdown_preset_path !== undefined) {
    options = applyAafOption(
      options,
      "setVideoMixdownPresetPath",
      args.video_mixdown_preset_path
    );
  }
  if (args.render_audio_effects !== undefined) {
    options = applyAafOption(
      options,
      "setRenderAudioEffects",
      args.render_audio_effects
    );
  }
  if (args.interleave_without_effects !== undefined) {
    options = applyAafOption(
      options,
      "setInterleaveWithoutEffects",
      args.interleave_without_effects
    );
  }
  if (args.preserve_parent_folder !== undefined) {
    options = applyAafOption(
      options,
      "setPreserveParentFolder",
      args.preserve_parent_folder
    );
  }

  const configuredOptions = aafOptionsSnapshot(
    options,
    args.audio_file_format
  );
  const exported = await ppro().ProjectConverter.exportAAF(
    sequence,
    args.output_path,
    options
  );
  if (!exported) throw new BridgeError("EXPORT_FAILED", "AAF export failed");
  return {
    exported: true,
    outputPath: args.output_path,
    options: configuredOptions,
    undoable: false
  };
}

async function exportOpenTimelineIo(args) {
  const project = await getActiveProject();
  const sequence = await findSequence(project);
  const exported = await ppro().ProjectConverter.exportAsOpenTimelineIO(
    sequence,
    args.output_path,
    true
  );
  if (!exported) {
    throw new BridgeError("EXPORT_FAILED", "OpenTimelineIO export failed");
  }
  return { exported: true, outputPath: args.output_path, undoable: false };
}

async function encodeProjectItem(args) {
  const project = await getActiveProject();
  const item = await requireClipProjectItem(project, args.item_id);
  const manager = ppro().EncoderManager.getManager();
  ensureEncoderEventJournal(manager);
  const started = await manager.encodeProjectItem(
    item,
    args.output_path,
    args.preset_path,
    0,
    args.remove_on_completion,
    args.start_queue_immediately
  );
  if (!started) throw new BridgeError("ENCODE_FAILED", "Project-item encode failed to start");
  return { started: true, outputPath: args.output_path, undoable: false };
}

async function encodeFile(args) {
  const manager = ppro().EncoderManager.getManager();
  ensureEncoderEventJournal(manager);
  const inPoint =
    args.in_seconds === undefined
      ? ppro().TickTime.TIME_ZERO
      : tickTimeFromSeconds(args.in_seconds);
  const outPoint =
    args.out_seconds === undefined
      ? ppro().TickTime.TIME_MAX
      : tickTimeFromSeconds(args.out_seconds);
  const started = await manager.encodeFile(
    args.input_path,
    args.output_path,
    args.preset_path,
    inPoint,
    outPoint,
    0,
    args.remove_on_completion,
    args.start_queue_immediately
  );
  if (!started) throw new BridgeError("ENCODE_FAILED", "File encode failed to start");
  return { started: true, outputPath: args.output_path, undoable: false };
}

async function getExportFileExtension(args) {
  const project = await getActiveProject();
  const sequence = await findSequence(project);
  return {
    extension: String(
      (await ppro().EncoderManager.getExportFileExtension(
        sequence,
        args.preset_path
      )) || ""
    )
  };
}

async function getMediaEncoderInfo() {
  const manager = ppro().EncoderManager.getManager();
  ensureEncoderEventJournal(manager);
  return { isAMEInstalled: Boolean(manager.isAMEInstalled) };
}

const ENCODER_EVENT_LIMIT = 200;
const encoderEventJournal = [];
let encoderEventSequence = 0;
let encoderEventManager = null;
let encoderEventListenersRegistered = false;
let encoderEventJournalStartedAt = null;

function normalizeEncoderEvent(type, event) {
  const payload = event && typeof event === "object" ? event : {};
  const jobId = payload.jobID ?? payload.jobId ?? null;
  const progress = Number(payload.progressAmount);
  const errorNumber = Number(payload.inErrorNumber);
  return {
    eventId: ++encoderEventSequence,
    type,
    occurredAt: new Date().toISOString(),
    jobId: jobId === null || jobId === undefined ? null : String(jobId),
    ...(Number.isFinite(progress) ? { progressAmount: progress } : {}),
    ...(Number.isFinite(errorNumber) ? { errorNumber } : {}),
    ...(Array.isArray(payload.outputFiles)
      ? { outputFiles: payload.outputFiles.map((value) => String(value)) }
      : {})
  };
}

function ensureEncoderEventJournal(manager) {
  if (encoderEventListenersRegistered && encoderEventManager === manager) return;
  if (!ppro().EventManager || typeof ppro().EventManager.addEventListener !== "function") {
    throw new BridgeError(
      "ENCODER_EVENTS_UNAVAILABLE",
      "Premiere UXP EventManager를 사용할 수 없습니다."
    );
  }
  const eventTypes = [
    ["queued", ppro().EncoderManager.EVENT_RENDER_QUEUE],
    ["progress", ppro().EncoderManager.EVENT_RENDER_PROGRESS],
    ["completed", ppro().EncoderManager.EVENT_RENDER_COMPLETE],
    ["error", ppro().EncoderManager.EVENT_RENDER_ERROR],
    ["cancelled", ppro().EncoderManager.EVENT_RENDER_CANCEL]
  ];
  for (const [type, eventName] of eventTypes) {
    ppro().EventManager.addEventListener(manager, eventName, (event) => {
      encoderEventJournal.push(normalizeEncoderEvent(type, event));
      if (encoderEventJournal.length > ENCODER_EVENT_LIMIT) {
        encoderEventJournal.splice(
          0,
          encoderEventJournal.length - ENCODER_EVENT_LIMIT
        );
      }
    });
  }
  encoderEventManager = manager;
  encoderEventListenersRegistered = true;
  encoderEventJournalStartedAt = new Date().toISOString();
}

async function listMediaEncoderEvents(args) {
  const manager = ppro().EncoderManager.getManager();
  ensureEncoderEventJournal(manager);
  const matching = encoderEventJournal.filter(
    (event) =>
      event.eventId > args.after_event_id &&
      (!args.job_id || event.jobId === args.job_id)
  );
  const events = matching.slice(0, args.limit);
  return {
    listenerStartedAt: encoderEventJournalStartedAt,
    latestEventId: encoderEventSequence,
    eventCount: events.length,
    truncated: matching.length > events.length,
    events,
    queueSnapshotAvailable: false,
    note:
      "Adobe UXP exposes encoder events received after listener registration, not an AME queue snapshot."
  };
}

async function launchMediaEncoder() {
  const manager = ppro().EncoderManager.getManager();
  ensureEncoderEventJournal(manager);
  const launched = await manager.launchEncoder();
  if (!launched) {
    throw new BridgeError("ENCODER_LAUNCH_FAILED", "Adobe Media Encoder launch failed");
  }
  return { launched: true, undoable: false };
}

async function startBatchEncode() {
  const manager = ppro().EncoderManager.getManager();
  ensureEncoderEventJournal(manager);
  const started = await manager.startBatchEncode();
  if (!started) {
    throw new BridgeError("ENCODE_FAILED", "AME batch encode failed to start");
  }
  return { started: true, undoable: false };
}

async function setEncoderXmpOptions(args) {
  const manager = ppro().EncoderManager.getManager();
  const applied = {};
  if (args.embedded_enabled !== undefined) {
    const updated = await manager.setEmbeddedXMPEnabled(args.embedded_enabled);
    if (!updated) {
      throw new BridgeError(
        "ENCODER_SETTINGS_FAILED",
        "Embedded XMP 설정을 변경하지 못했습니다."
      );
    }
    applied.embeddedEnabled = args.embedded_enabled;
  }
  if (args.sidecar_enabled !== undefined) {
    const updated = await manager.setSidecarXMPEnabled(args.sidecar_enabled);
    if (!updated) {
      throw new BridgeError(
        "ENCODER_SETTINGS_FAILED",
        "Sidecar XMP 설정을 변경하지 못했습니다.",
        { applied }
      );
    }
    applied.sidecarEnabled = args.sidecar_enabled;
  }
  return {
    updated: true,
    ...applied,
    undoable: false,
    nonAtomic: Object.keys(applied).length > 1
  };
}

async function openCapturesFolder() {
  const dataFolder = await storage.localFileSystem.getDataFolder();
  try {
    const existing = await dataFolder.getEntry("captures");
    if (existing) return existing;
  } catch (_error) {
    // Create below.
  }
  try {
    return await dataFolder.createFolder("captures");
  } catch (_error) {
    return dataFolder.getEntry("captures");
  }
}

async function captureFrame(args) {
  const project = await getActiveProject();
  const sequence = await findSequence(project);
  const time =
    args.time_seconds === undefined
      ? await sequence.getPlayerPosition()
      : tickTimeFromSeconds(args.time_seconds);
  const sequenceSize = await readSequenceFrameSize(sequence);
  const scale = Math.min(1, 1280 / Math.max(1, sequenceSize.width));
  const previewSize = {
    width: Math.max(1, Math.round(sequenceSize.width * scale)),
    height: Math.max(1, Math.round(sequenceSize.height * scale))
  };
  const folder = await openCapturesFolder();
  const filename = `deno_capture_${Date.now()}_${Math.random()
    .toString(16)
    .slice(2)}.jpg`;
  const result = await captureFrameWithStrategies({
    sequence,
    time,
    folder,
    basename: filename,
    previewSize,
    sequenceSize
  });
  return {
    captured: true,
    capturePath: result.path,
    mimeType: "image/jpeg",
    width: result.width,
    height: result.height,
    timeSeconds: secondsOf(time),
    temporary: true,
    semantic: "sequence-frame",
    attempts: result.attempts,
    strategyUsed: result.strategyUsed
  };
}

module.exports = {
  category: "export",
  handlers: [
    { name: "export_sequence", writes: true, dangerous: true, validate: validateExportSequence, execute: exportSequence },
    { name: "add_to_render_queue", writes: true, dangerous: true, validate: validateRenderQueue, execute: addToRenderQueue },
    { name: "start_batch_encode", writes: true, dangerous: true, validate: validateNoArgs, execute: startBatchEncode },
    { name: "export_frame", writes: true, dangerous: true, validate: validateExportFrame, execute: exportFrame },
    { name: "export_as_fcp_xml", writes: true, dangerous: true, validate: validateOutputPath, execute: exportAsFcpXml },
    { name: "export_aaf", writes: true, dangerous: true, validate: validateAaf, execute: exportAaf },
    { name: "export_open_timeline_io", writes: true, dangerous: true, validate: validateOutputPath, execute: exportOpenTimelineIo },
    { name: "encode_project_item", writes: true, dangerous: true, validate: validateEncodeItem, execute: encodeProjectItem },
    { name: "encode_file", writes: true, dangerous: true, validate: validateEncodeFile, execute: encodeFile },
    { name: "get_export_file_extension", writes: false, validate: validatePreset, execute: getExportFileExtension },
    { name: "get_media_encoder_info", writes: false, validate: validateNoArgs, execute: getMediaEncoderInfo },
    { name: "list_media_encoder_events", writes: false, validate: validateEncoderEvents, execute: listMediaEncoderEvents },
    { name: "launch_media_encoder", writes: true, dangerous: true, validate: validateNoArgs, execute: launchMediaEncoder },
    { name: "set_encoder_xmp_options", writes: true, dangerous: true, validate: validateEncoderXmpOptions, execute: setEncoderXmpOptions },
    { name: "capture_frame", writes: false, validate: validateCapture, execute: captureFrame }
  ]
};
