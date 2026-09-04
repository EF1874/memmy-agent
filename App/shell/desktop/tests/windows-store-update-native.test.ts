import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const helperSourcePath = fileURLToPath(new URL(
  "../native/windows-store-update/MemmyStoreUpdate.cpp",
  import.meta.url
));

const sourceBetween = (
  source: string,
  startMarker: string,
  endMarker: string
): string => {
  const start = source.indexOf(startMarker);
  if (start < 0) {
    throw new Error(`Missing source marker: ${startMarker}`);
  }
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (end < 0) {
    throw new Error(`Missing source marker: ${endMarker}`);
  }
  return source.slice(start, end);
};

describe("Windows Store native update helper boundary", () => {
  it("exposes StoreContext commands plus authority-bound legacy takeover and cleanup", async () => {
    const source = await readFile(helperSourcePath, "utf8");
    const commands = [...source.matchAll(/value == L"([a-z-]+)"/gu)]
      .map((match) => match[1]);

    expect(commands).toEqual([
      "identity",
      "package-family-registration",
      "check",
      "download-silent",
      "download-user",
      "handoff-install",
      "launch-store-update-finalizer",
      "finalize-store-update",
      "startup-status",
      "startup-enable",
      "startup-disable",
      "prepare-legacy-takeover",
      "finalize-legacy-cleanup",
      "finalize-legacy-cleanup-breakaway-launcher",
      "finalize-legacy-cleanup-unpackaged"
    ]);
    expect(source).toContain("StoreContext::GetDefault()");
    expect(source).toContain("TrySilentDownloadStorePackageUpdatesAsync");
    expect(source).toContain("RequestDownloadStorePackageUpdatesAsync");
    expect(source).toContain("TrySilentDownloadAndInstallStorePackageUpdatesAsync");
    expect(source).toContain("namespace_directory.filename() != options.package_family_name");
    expect(source).toContain("options.package_family_name /");
    expect(source).toContain('store_startup_task_id[] = L"MemmyStartupTask"');
    expect(source).toContain("StartupTask::GetAsync(store_startup_task_id)");
    expect(source).toContain("RequestEnableAsync()");
    expect(source).toContain("startup_task.Disable()");
    expect(source).toContain("StartupTaskState::DisabledByUser");
    expect(source).toContain("StartupTaskState::DisabledByPolicy");
    expect(source).toContain("CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)");
    expect(source).toContain("QueryFullProcessImageNameW");
    expect(source).toContain("WM_CLOSE");
    expect(source).toContain("TerminateProcess");
    expect(source).toContain("stop_legacy_processes(options.legacy_install_directory)");
    expect(source).toContain("Files may already be partially removed, including Memmy.exe");
    expect(source).toContain("--legacy-install-directory");
    expect(source).toContain("--legacy-executable-path");
    expect(source).toContain("--transition-id");
    expect(source).toContain("--attempt-id");
    expect(source).toContain("is_canonical_uuid");
    expect(source).toContain('L"store-transition" / L"diagnostics"');
    expect(source).not.toContain("--diagnostic-log-path");
    expect(source).not.toContain("--log-path must");
    expect(source).toContain("legacy-cleanup-result-v2");
    expect(source).not.toContain("legacy-cleanup-result-v1");
    expect(source).toContain("child_result.transition_id == legacy_cleanup_diagnostics->transition_id");
    expect(source).toContain("child_result.attempt_id == legacy_cleanup_diagnostics->attempt_id");
    expect(source).toContain("child_result.failure_process_role");
    expect(source).toContain("child_result.win32_error");
    expect(source).toContain("legacy_cleanup_diagnostics->current_operation = child_result.operation");
    expect(source).toContain("legacy_cleanup_diagnostics->current_target = child_result.target");
    expect(source).toContain("write_legacy_cleanup_error_to_stderr");
    expect(source).toContain('<< ",\\\"transitionId\\\":\\\""');
    expect(source).toContain('<< ",\\\"attemptId\\\":\\\""');
    expect(source).toContain("set_breakaway_policy ? 150000 : 120000");
    expect(source).not.toContain("Unable to append the fixed legacy cleanup diagnostic log");
    expect(source).toContain("PROCESS_CREATION_DESKTOP_APP_BREAKAWAY_ENABLE_PROCESS_TREE");
    expect(source).toContain("breakawayLauncherHasPackageIdentity=");
    expect(source).toContain("breakawayPolicyAppliesToChildCreation=true");
    expect(source).not.toContain("Legacy cleanup breakaway launcher still has package identity");
    expect(source).toContain("Refusing to mutate the real legacy installation from a packaged process");
    expect(source).toContain("Software\\\\886615f7-a04c-57ec-a2dd-9161dbe1a7c4");
    expect(source).toContain("ProcessIdToSessionId");
    expect(source).toContain("GetCurrentPackageFullName");
    expect(source).toContain("read_legacy_cleanup_process_result");
    expect(source).toContain("child_result.hresult");
    expect(source).toContain("struct DeleteTreeResult");
    expect(source).toContain("failed_path");
    expect(source).toContain("KEY_WOW64_32KEY");
    expect(source).toContain("KEY_WOW64_64KEY");
    expect(source).toContain('legacy_app_user_model_id[] = L"cn.memtensor.memmy"');
    expect(source).toContain(
      "delete_registry_value_if_present(run_key, legacy_app_user_model_id);"
    );
    for (const diagnosticEvent of [
      "process-context",
      "authority-registry",
      "legacy-processes-stop",
      "install-directory-delete",
      "install-directory-post-check",
      "uninstall-registry-delete",
      "installer-authority-registry-delete",
      "run-registry-delete",
      "user-path-update",
      "start-menu-shortcut-delete",
      "launcher-directory-delete",
      "apps-folder-shortcut-create"
    ]) {
      expect(source).toContain(diagnosticEvent);
    }
    const argumentBuilderStart = source.indexOf("std::vector<std::wstring> build_legacy_cleanup_arguments(");
    const argumentBuilderEnd = source.indexOf("std::string legacy_cleanup_process_role_for_command", argumentBuilderStart);
    const argumentBuilder = source.slice(argumentBuilderStart, argumentBuilderEnd);
    expect(argumentBuilder.match(/L"--transition-id", options\.transition_id/gu)).toHaveLength(1);
    expect(argumentBuilder.match(/L"--attempt-id", options\.attempt_id/gu)).toHaveLength(1);
    expect(argumentBuilder).toContain("if (include_external_helper)");
    expect(source).toMatch(/L"finalize-legacy-cleanup-breakaway-launcher",\s+legacy_options,\s+true\)/u);
    expect(source).toMatch(/L"finalize-legacy-cleanup-unpackaged",\s+legacy_options,\s+false\)/u);
    expect(source).toMatch(
      /Command::FinalizeLegacyCleanupBreakawayLauncher[\s\S]*?run_legacy_cleanup_process\(\s*legacy_options\.external_helper_path,[\s\S]*?L"finalize-legacy-cleanup-unpackaged"/u,
    );
    expect(source).not.toContain('L"Programs" / L"Memmy"');
    expect(source).not.toMatch(/WindowsApps[\\/][^"\r\n]*_\d+\.\d+\.\d+\.\d+/iu);
  });

  it("queries current-user package registration from the package-family API result", async () => {
    const source = await readFile(helperSourcePath, "utf8");
    const registrationQuery = sourceBetween(
      source,
      "std::vector<std::wstring> registered_package_full_names(",
      "void emit_package_family_registration("
    );
    const registrationOutput = sourceBetween(
      source,
      "void emit_package_family_registration(",
      "struct InstalledPackageIdentity"
    );
    const argumentParsing = sourceBetween(
      source,
      "for (int index = 2; index < argc; ++index)",
      "init_apartment(apartment_type::single_threaded);"
    );
    const commandEntry = sourceBetween(
      source,
      "if (command == Command::PackageFamilyRegistration)",
      "init_apartment(apartment_type::single_threaded);"
    );

    expect(registrationQuery.match(/GetPackagesByPackageFamily\(/gu)).toHaveLength(2);
    expect(registrationQuery).toContain("package_full_names.data()");
    expect(registrationQuery).toContain("package_full_name_buffer.data()");
    expect(registrationQuery).toContain("read_count");
    expect(registrationQuery).not.toContain("PackageIdFromFullName");
    expect(registrationQuery).toContain("HRESULT_FROM_WIN32(result)");
    expect(registrationOutput).toContain(
      '\\"type\\":\\"package-family-registration\\"'
    );
    expect(registrationOutput).toContain('\\"packageFamilyName\\":\\"');
    expect(registrationOutput).toContain('\\"registered\\":');
    expect(registrationOutput).toContain('\\"packageFullNames\\":[');
    expect(registrationOutput.match(/write_json_line\(/gu)).toHaveLength(1);
    expect(argumentParsing).toContain(
      "if (command == Command::PackageFamilyRegistration)"
    );
    expect(argumentParsing).toContain(
      'argument != L"--package-family-name"'
    );
    expect(argumentParsing).toContain(
      "Package-family registration accepts only --package-family-name"
    );
    expect(commandEntry).toContain("emit_package_family_registration(");
    expect(commandEntry).toContain(
      "is_valid_package_family_name(registration_package_family_name)"
    );
    expect(commandEntry).toContain("return 0;");
    expect(commandEntry).not.toContain("current_process_has_package_identity");
  });

  it("hands off from the breakaway launcher without weakening the external cleanup identity gate", async () => {
    const source = await readFile(helperSourcePath, "utf8");
    const validation = sourceBetween(
      source,
      "void validate_legacy_transition_options(",
      "std::vector<std::wstring> build_legacy_cleanup_arguments("
    );
    const breakawayLauncher = sourceBetween(
      source,
      "if (command == Command::FinalizeLegacyCleanupBreakawayLauncher)",
      "if (command == Command::FinalizeLegacyCleanupUnpackaged)"
    );
    const externalEntry = sourceBetween(
      source,
      "if (command == Command::FinalizeLegacyCleanupUnpackaged)",
      "if (command == Command::HandoffInstall)"
    );
    const destructiveCleanup = sourceBetween(
      source,
      "void finalize_legacy_cleanup_unpacked(",
      "void launch_store_update_finalizer_breakaway("
    );

    expect(validation).toContain(
      "normalize_absolute_path(options.external_helper_path) !="
    );
    expect(validation).toContain("normalize_absolute_path(expected_helper)");
    expect(validation).toContain(
      "is_windows_apps_path(options.external_helper_path)"
    );
    expect(validation).toContain(
      "std::filesystem::is_regular_file(options.external_helper_path, file_error)"
    );

    const validationCall =
      "validate_legacy_transition_options(legacy_options, true, true);";
    expect(breakawayLauncher).toContain(validationCall);
    expect(breakawayLauncher).toContain(
      'initialize_legacy_cleanup_diagnostics(legacy_options, "breakaway-launcher")'
    );
    expect(breakawayLauncher).not.toMatch(
      /if\s*\(\s*current_process_has_package_identity\(\)\s*\)\s*\{[\s\S]*?throw\s+hresult_error/u
    );
    expect(breakawayLauncher).not.toContain(
      "Legacy cleanup breakaway launcher still has package identity"
    );
    expect(breakawayLauncher).toMatch(
      /run_legacy_cleanup_process\(\s*legacy_options\.external_helper_path,\s*build_legacy_cleanup_arguments\(\s*legacy_options\.external_helper_path,\s*L"finalize-legacy-cleanup-unpackaged",\s*legacy_options,\s*false\s*\),\s*false\s*\);/u
    );
    expect(
      breakawayLauncher.indexOf("run_legacy_cleanup_process(")
    ).toBeGreaterThan(breakawayLauncher.indexOf(validationCall));

    expect(externalEntry).toContain(
      "validate_legacy_transition_options(legacy_options, true, false);"
    );
    expect(externalEntry).toContain(
      "Unpackaged legacy cleanup received an external helper path"
    );
    expect(externalEntry).toContain(
      "finalize_legacy_cleanup_unpacked(legacy_options);"
    );
    expect(destructiveCleanup).toMatch(
      /if\s*\(\s*current_process_has_package_identity\(\)\s*\)\s*\{[\s\S]*?throw\s+hresult_error\(\s*E_ACCESSDENIED,[\s\S]*?L"Refusing to mutate the real legacy installation from a packaged process"/u
    );
  });

  it("fails closed when the fixed diagnostic result channel is unavailable", async () => {
    const source = await readFile(helperSourcePath, "utf8");
    const initialization = sourceBetween(
      source,
      "void initialize_legacy_cleanup_diagnostics(",
      "std::filesystem::path legacy_cleanup_process_result_path("
    );
    const childResultHandling = sourceBetween(
      source,
      "void run_legacy_cleanup_process(",
      "void finalize_legacy_cleanup_unpacked("
    );

    expect(initialization).not.toContain("noexcept");
    expect(initialization).not.toContain("catch (...)");
    expect(initialization).toContain("write_text_file_atomic(");
    expect(initialization).toContain('L".result"');
    expect(initialization).toContain("legacy-cleanup-result-v2");
    expect(initialization).toContain("ProcessIdToSessionId");
    expect(initialization).toContain("APPMODEL_ERROR_NO_PACKAGE");
    expect(initialization).toContain(
      "Unable to initialize the fixed legacy cleanup diagnostic log"
    );
    expect(childResultHandling).toContain(
      "const HRESULT child_exit_hresult = static_cast<HRESULT>(exit_code)"
    );
    expect(childResultHandling).toContain("child-result-channel");
  });

  it("deletes and verifies both registry views using authority-bound values", async () => {
    const source = await readFile(helperSourcePath, "utf8");
    const authorityValidation = sourceBetween(
      source,
      "bool validate_legacy_install_authority(",
      "ULONGLONG query_process_creation_time("
    );
    const registryDelete = sourceBetween(
      source,
      "void delete_registry_tree_if_present(",
      "void delete_registry_value_if_present("
    );
    const destructiveCleanup = sourceBetween(
      source,
      "void finalize_legacy_cleanup_unpacked(",
      "void launch_store_update_finalizer_breakaway("
    );

    expect(authorityValidation).toContain("recorded_install_directory_32");
    expect(authorityValidation).toContain("recorded_install_directory_64");
    expect(authorityValidation).toContain("KEY_WOW64_32KEY");
    expect(authorityValidation).toContain("KEY_WOW64_64KEY");
    expect(authorityValidation).toContain("authority_matches");
    expect(registryDelete).toContain(
      "DELETE | KEY_ENUMERATE_SUB_KEYS | KEY_QUERY_VALUE | KEY_SET_VALUE | view_access"
    );
    expect(registryDelete).toContain("RegDeleteTreeW(key, nullptr)");
    expect(registryDelete).toContain("RegDeleteKeyExW(");
    expect(registryDelete).not.toContain("view=process-default");
    expect(destructiveCleanup.match(/delete_registry_tree_if_present\(/gu)).toHaveLength(4);
    expect(destructiveCleanup.match(/registry_tree_exists\(/gu)).toHaveLength(4);
    expect(destructiveCleanup).toContain("RegOpenKeyExW(post-check)");
  });

  it("treats the Shell-reported shortcut path as advisory and verifies the exact desktop file", async () => {
    const source = await readFile(helperSourcePath, "utf8");
    const shortcutCreation = sourceBetween(
      source,
      "void create_apps_folder_shortcut(",
      "std::string utf8("
    );
    const destructiveCleanup = sourceBetween(
      source,
      "void finalize_legacy_cleanup_unpacked(",
      "void launch_store_update_finalizer_breakaway("
    );

    expect(shortcutCreation).not.toContain("error-ignored");
    expect(shortcutCreation).not.toContain("path-present-unverified");
    expect(shortcutCreation).toContain(
      "Unable to remove the existing Memmy desktop shortcut"
    );
    expect(shortcutCreation).not.toContain(
      "Windows did not report the created Memmy desktop shortcut path"
    );
    expect(shortcutCreation).not.toMatch(
      /set_legacy_cleanup_failure_context\(\s*"SHGetNameFromIDList"/u
    );
    expect(shortcutCreation).not.toMatch(
      /if\s*\(\s*FAILED\(created_path_result\)/u
    );
    expect(shortcutCreation).not.toContain(
      "check_hresult(created_path_result)"
    );
    expect(shortcutCreation).toContain("path-resolution-unavailable");
    expect(shortcutCreation).toContain(
      "!created_shortcut_path.empty() &&"
    );
    expect(shortcutCreation).toContain(
      "normalize_absolute_path(created_shortcut_path) !="
    );
    expect(shortcutCreation).toContain(
      "Windows created the Memmy desktop shortcut at an unexpected path"
    );
    expect(shortcutCreation).toContain(
      "Windows did not create the expected Memmy desktop shortcut"
    );
    expect(shortcutCreation).toContain("FILE_ATTRIBUTE_DIRECTORY");
    expect(shortcutCreation).toContain("FILE_ATTRIBUTE_REPARSE_POINT");
    expect(shortcutCreation).toContain(
      "The created Memmy desktop shortcut is not a regular file"
    );
    expect(shortcutCreation.indexOf("check_hresult(link_result);")).toBeLessThan(
      shortcutCreation.indexOf("std::filesystem::exists(")
    );
    expect(destructiveCleanup).toContain("FOLDERID_Programs");
    expect(destructiveCleanup).toContain(
      "Unable to delete the legacy Memmy Start Menu shortcut"
    );
    expect(destructiveCleanup).toContain(
      "The legacy Memmy launch proxy directory is still present after cleanup"
    );
    expect(destructiveCleanup.match(/GetFileAttributesW\(post-check\)/gu).length)
      .toBeGreaterThanOrEqual(2);
  });

  it("keeps Store transition control files outside any removable legacy install tree", async () => {
    const source = await readFile(helperSourcePath, "utf8");
    const diagnosticPathResolution = sourceBetween(
      source,
      "std::filesystem::path resolve_legacy_cleanup_diagnostics_directory(",
      "void initialize_legacy_cleanup_diagnostics("
    );
    const authorityValidation = sourceBetween(
      source,
      "bool validate_legacy_install_authority(",
      "ULONGLONG query_process_creation_time("
    );
    const treeDeletion = sourceBetween(
      source,
      "DeleteTreeResult delete_directory_tree_once(",
      "void remove_legacy_install_directory("
    );

    expect(diagnosticPathResolution).toContain(
      "paths_overlap(options.legacy_install_directory, memmy_directory)"
    );
    expect(authorityValidation).toContain(
      "paths_overlap(legacy_install_directory, store_control_directory)"
    );
    expect(treeDeletion).toContain("RemoveDirectoryW(empty-directory)");
  });
});
