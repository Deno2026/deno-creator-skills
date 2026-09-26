export const WRITE_TOOLS = new Set([
  "import_media",
  "create_bin",
  "move_item_to_bin",
  "move_items_to_bin",
  "delete_bin",
  "rename_bin",
  "create_smart_bin",
  "delete_project_item",
  "delete_multiple_project_items",
  "rename_project_item",
  "create_subclip",
  "save_project",
  "save_project_as",
  "open_project",
  "create_project",
  "close_project",
  "import_ae_comps",
  "import_sequences",
  "set_transcode_on_ingest",
  "relink_media",
  "refresh_media",
  "set_offline",
  "set_override_frame_rate",
  "set_override_pixel_aspect_ratio",
  "set_scale_to_frame_size",
  "set_start_time",
  "set_clip_start_time",
  "import_image_sequence",
  "clear_item_in_out",
  "set_item_in_out",
  "set_metadata",
  "set_color_label",
  "set_footage_interpretation",
  "set_xmp_metadata",
  "add_custom_metadata_field",
  "set_project_panel_metadata",
  "add_to_timeline",
  "remove_from_timeline",
  "set_playhead_position",
  "ripple_delete",
  "slip_edit",
  "rename_clip",
  "overwrite_clip",
  "trim_clip",
  "duplicate_clip",
  "enable_disable_clip",
  "lift_selection",
  "extract_selection",
  "select_clips_by_name",
  "select_all_clips",
  "deselect_all_clips",
  "select_clips_in_range",
  "select_clips_by_color",
  "invert_selection",
  "select_disabled_clips",
  "set_clip_selection",
  "create_sequence_from_clips",
  "close_sequence",
  "set_zero_point",
  "set_sequence_in_out_points",
  "set_active_sequence",
  "open_sequence",
  "create_sequence",
  "duplicate_sequence",
  "delete_sequence",
  "set_sequence_settings",
  "set_sequence_audio_settings",
  "create_subsequence",
  "create_sequence_from_preset",
  "attach_custom_property",
  "set_sequence_frame_rate",
  "set_sequence_resolution",
  "set_sequence_pixel_aspect_ratio",
  "set_sequence_field_type",
  "set_sequence_display_format",
  "scene_edit_detection",
  "rename_track",
  "toggle_track_visibility",
  "move_playhead_to_edit",
  "open_in_source",
  "close_source_monitor",
  "close_all_source_clips",
  "set_source_in_out",
  "insert_from_source",
  "overwrite_from_source",
  "play_source_monitor",
  "set_source_monitor_position",
  "apply_effect",
  "batch_apply_effect",
  "remove_effect",
  "remove_effect_by_name",
  "remove_all_effects",
  "set_clip_opacity",
  "set_clip_scale",
  "set_clip_position",
  "set_clip_rotation",
  "set_clip_anchor_point",
  "set_uniform_scale",
  "set_scale_width_height",
  "set_anti_alias_quality",
  "set_effect_property",
  "add_keyframe",
  "remove_keyframe",
  "remove_keyframe_range",
  "set_keyframe_interpolation",
  "set_color_value",
  "apply_audio_effect",
  "set_clip_volume",
  "adjust_audio_levels",
  "set_clip_pan",
  "add_audio_keyframes",
  "mute_track",
  "add_transition_to_clip",
  "add_transition",
  "remove_transition",
  "add_marker",
  "delete_marker",
  "update_marker",
  "add_marker_to_project_item",
  "export_sequence",
  "export_frame",
  "export_as_fcp_xml",
  "export_aaf",
  "encode_project_item",
  "encode_file",
  "add_to_render_queue",
  "start_batch_encode",
  "export_open_timeline_io",
  "launch_media_encoder",
  "set_encoder_xmp_options",
  "import_mogrt",
  "import_mogrt_from_library",
  "move_clip",
  "remove_selected_clips",
  "batch_enable_disable",
  "batch_rename_clips",
  "manage_proxies",
  "rename_caption_track",
  "set_caption_track_mute",
  "pause_growing_media",
  "set_project_ingest_enabled",
  "set_project_scratch_disk_mode",
  "import_clip_transcript_json",
  "set_app_preference",
  "clear_custom_property",
  "set_project_item_input_lut_id",
  "open_file_in_source_monitor",
]);

export const DANGEROUS_TOOLS = new Set([
  "delete_bin",
  "delete_project_item",
  "delete_multiple_project_items",
  "save_project",
  "save_project_as",
  "open_project",
  "create_project",
  "close_project",
  "relink_media",
  "set_offline",
  "delete_sequence",
  "export_sequence",
  "export_frame",
  "export_as_fcp_xml",
  "export_aaf",
  "encode_project_item",
  "encode_file",
  "add_to_render_queue",
  "start_batch_encode",
  "export_open_timeline_io",
  "launch_media_encoder",
  "set_encoder_xmp_options",
  "manage_proxies",
  "set_project_scratch_disk_mode",
  "import_clip_transcript_json",
  "set_app_preference",
]);

export function isWriteTool(toolName) {
  return WRITE_TOOLS.has(String(toolName || ""));
}

export function isDangerousTool(toolName) {
  return DANGEROUS_TOOLS.has(String(toolName || ""));
}

export function blockedWriteMessage(toolName) {
  return (
    `Blocked write tool '${toolName}'. ` +
    "Re-run with --allow-write for this bounded write in the current requested scope."
  );
}

export function blockedDangerousMessage(toolName) {
  return (
    `Blocked dangerous tool '${toolName}'. ` +
    "Re-run with both --allow-write and --allow-dangerous for this save, deletion, external-output, relink/offline, preference, or other disruptive operation."
  );
}

export function requireWritePermission(
  toolName,
  { allowWrite = false, allowDangerous = false } = {},
) {
  if (isDangerousTool(toolName) && !allowDangerous) {
    const error = new Error(blockedDangerousMessage(toolName));
    error.name = "DangerousPermissionError";
    error.code = "DANGEROUS_PERMISSION_REQUIRED";
    throw error;
  }
  if (isWriteTool(toolName) && !allowWrite) {
    const error = new Error(blockedWriteMessage(toolName));
    error.name = "WritePermissionError";
    error.code = "WRITE_PERMISSION_REQUIRED";
    throw error;
  }
}
