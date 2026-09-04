#include <windows.h>
#include <appmodel.h>
#include <shlobj_core.h>
#include <shobjidl_core.h>
#include <tlhelp32.h>

#include <algorithm>
#include <array>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cwctype>
#include <exception>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <optional>
#include <sstream>
#include <string>
#include <string_view>
#include <thread>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>

#include <winrt/Windows.ApplicationModel.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Foundation.Collections.h>
#include <winrt/Windows.Services.Store.h>
#include <winrt/base.h>

using namespace winrt;
using namespace Windows::ApplicationModel;
using namespace Windows::Foundation;
using namespace Windows::Foundation::Collections;
using namespace Windows::Services::Store;

namespace
{
    enum class Command
    {
        Identity,
        PackageFamilyRegistration,
        Check,
        DownloadSilent,
        DownloadUser,
        HandoffInstall,
        LaunchStoreUpdateFinalizer,
        FinalizeStoreUpdate,
        StartupStatus,
        StartupEnable,
        StartupDisable,
        PrepareLegacyTakeover,
        FinalizeLegacyCleanup,
        FinalizeLegacyCleanupBreakawayLauncher,
        FinalizeLegacyCleanupUnpackaged
    };

    constexpr wchar_t store_startup_task_id[] = L"MemmyStartupTask";
    constexpr wchar_t legacy_app_user_model_id[] = L"cn.memtensor.memmy";

    struct StoreInstallHandoffOptions
    {
        std::filesystem::path external_helper_path;
        std::filesystem::path state_path;
        std::filesystem::path result_path;
        std::filesystem::path log_path;
        DWORD old_process_id = 0;
        std::wstring baseline_package_version;
        std::wstring baseline_package_full_name;
        std::wstring created_at;
        std::wstring aumid;
        std::wstring package_family_name;
        std::wstring mode;
    };

    struct StoreInstallResultFile
    {
        bool available = false;
        std::string state;
        std::string hresult;
        std::string reason;
    };

    struct LegacyTransitionOptions
    {
        std::filesystem::path external_helper_path;
        std::filesystem::path legacy_install_directory;
        std::filesystem::path legacy_executable_path;
        std::filesystem::path shortcut_path;
        std::wstring aumid;
        std::wstring package_family_name;
        std::wstring transition_id;
        std::wstring attempt_id;
    };

    struct DeleteTreeResult
    {
        DWORD win32_error = ERROR_SUCCESS;
        std::filesystem::path failed_path;
        std::string operation;
    };

    struct LegacyCleanupProcessResult
    {
        bool available = false;
        HRESULT hresult = E_FAIL;
        std::string process_role;
        std::string failure_process_role;
        std::string transition_id;
        std::string attempt_id;
        std::optional<DWORD> win32_error;
        std::string operation;
        std::string target;
        std::string message;
    };

    struct LegacyCleanupDiagnostics
    {
        std::filesystem::path directory_path;
        std::filesystem::path log_path;
        std::string process_role;
        std::string failure_process_role;
        std::string transition_id;
        std::string attempt_id;
        DWORD process_id = 0;
        DWORD session_id = 0;
        bool session_id_available = false;
        LONG package_identity_result = ERROR_SUCCESS;
        bool has_package_identity = false;
        std::string package_full_name;
        std::string current_operation;
        std::string current_target;
        std::optional<DWORD> current_win32_error;
    };

    std::optional<LegacyCleanupDiagnostics> legacy_cleanup_diagnostics;

    std::string utf8(const std::wstring& value);
    std::string utc_timestamp();
    std::string hresult_text(HRESULT value);
    std::string single_line(std::string value);
    bool append_legacy_cleanup_diagnostic(
        const std::string& event,
        const std::string& outcome = "",
        const std::string& operation = "",
        const std::string& target = "",
        std::optional<DWORD> win32_error = std::nullopt,
        std::optional<HRESULT> hresult = std::nullopt,
        const std::string& detail = "") noexcept;
    void begin_legacy_cleanup_operation(
        const std::string& operation,
        const std::string& target = "") noexcept;
    void complete_legacy_cleanup_operation(const std::string& detail = "") noexcept;
    void set_legacy_cleanup_failure_context(
        const std::string& operation,
        const std::string& target,
        std::optional<DWORD> win32_error = std::nullopt) noexcept;
    void write_text_file_atomic(
        const std::filesystem::path& target_path,
        const std::string& contents);

    struct ProcessSnapshotEntry
    {
        DWORD process_id;
        DWORD parent_process_id;
        ULONGLONG creation_time;
        std::filesystem::path image_path;
        bool image_path_verified = false;
    };

    std::string escape_json(std::string_view value)
    {
        std::ostringstream output;
        for (const char character : value)
        {
            switch (character)
            {
            case '\\':
                output << "\\\\";
                break;
            case '"':
                output << "\\\"";
                break;
            case '\n':
                output << "\\n";
                break;
            case '\r':
                output << "\\r";
                break;
            case '\t':
                output << "\\t";
                break;
            default:
                if (static_cast<unsigned char>(character) < 0x20)
                {
                    output << "\\u"
                           << std::hex
                           << std::setw(4)
                           << std::setfill('0')
                           << static_cast<int>(static_cast<unsigned char>(character));
                }
                else
                {
                    output << character;
                }
            }
        }
        return output.str();
    }

    void write_json_line(const std::string& value)
    {
        std::cout << value << '\n';
        std::cout.flush();
    }

    std::string update_state_name(StorePackageUpdateState state)
    {
        switch (state)
        {
        case StorePackageUpdateState::Pending:
            return "pending";
        case StorePackageUpdateState::Downloading:
            return "downloading";
        case StorePackageUpdateState::Deploying:
            return "deploying";
        case StorePackageUpdateState::Completed:
            return "completed";
        case StorePackageUpdateState::Canceled:
            return "canceled";
        case StorePackageUpdateState::ErrorLowBattery:
            return "error-low-battery";
        case StorePackageUpdateState::ErrorWiFiRecommended:
            return "error-wifi-recommended";
        case StorePackageUpdateState::ErrorWiFiRequired:
            return "error-wifi-required";
        case StorePackageUpdateState::OtherError:
        default:
            return "other-error";
        }
    }

    std::string startup_task_state_name(StartupTaskState state)
    {
        switch (state)
        {
        case StartupTaskState::Disabled:
            return "disabled";
        case StartupTaskState::DisabledByUser:
            return "disabled-by-user";
        case StartupTaskState::DisabledByPolicy:
            return "disabled-by-policy";
        case StartupTaskState::Enabled:
        case StartupTaskState::EnabledByPolicy:
            return "enabled";
        default:
            throw hresult_error(E_UNEXPECTED, L"Windows returned an unknown StartupTask state");
        }
    }

    std::string package_version(const PackageVersion& version)
    {
        std::ostringstream output;
        output << version.Major << '.'
               << version.Minor << '.'
               << version.Build << '.'
               << version.Revision;
        return output.str();
    }

    std::string current_application_user_model_id()
    {
        UINT32 length = 0;
        LONG result = GetCurrentApplicationUserModelId(&length, nullptr);
        if (result != ERROR_INSUFFICIENT_BUFFER || length == 0)
        {
            throw hresult_error(HRESULT_FROM_WIN32(result), L"Current process has no application user model ID");
        }

        std::vector<wchar_t> value(length);
        result = GetCurrentApplicationUserModelId(&length, value.data());
        check_hresult(HRESULT_FROM_WIN32(result));
        return to_string(hstring(value.data()));
    }

    HWND parse_window_handle(const std::wstring& value)
    {
        if (value.empty())
        {
            return nullptr;
        }

        wchar_t* end = nullptr;
        const unsigned long long parsed = std::wcstoull(value.c_str(), &end, 10);
        if (end == value.c_str() || *end != L'\0' || parsed == 0)
        {
            throw hresult_invalid_argument(L"--hwnd must be a non-zero decimal window handle");
        }
        return reinterpret_cast<HWND>(static_cast<uintptr_t>(parsed));
    }

    bool is_valid_aumid(const std::wstring& value)
    {
        const auto separator = value.find(L'!');
        if (separator == std::wstring::npos ||
            separator == 0 ||
            separator == value.size() - 1 ||
            value.find(L'!', separator + 1) != std::wstring::npos)
        {
            return false;
        }
        return std::all_of(value.begin(), value.end(), [](wchar_t character)
        {
            return character == L'!' ||
                character == L'.' ||
                character == L'_' ||
                character == L'-' ||
                (character >= L'0' && character <= L'9') ||
                (character >= L'A' && character <= L'Z') ||
                (character >= L'a' && character <= L'z');
        });
    }

    bool is_canonical_uuid(const std::wstring& value)
    {
        if (value.size() != 36)
        {
            return false;
        }
        for (size_t index = 0; index < value.size(); ++index)
        {
            const wchar_t character = value[index];
            if (index == 8 || index == 13 || index == 18 || index == 23)
            {
                if (character != L'-')
                {
                    return false;
                }
                continue;
            }
            if (!((character >= L'0' && character <= L'9') ||
                  (character >= L'a' && character <= L'f') ||
                  (character >= L'A' && character <= L'F')))
            {
                return false;
            }
        }
        return true;
    }

    std::filesystem::path resolve_environment_path(
        const wchar_t* variable_name,
        const wchar_t* failure_context)
    {
        const DWORD required_length = GetEnvironmentVariableW(variable_name, nullptr, 0);
        if (required_length == 0)
        {
            throw hresult_error(
                HRESULT_FROM_WIN32(GetLastError()),
                failure_context);
        }

        std::vector<wchar_t> value(required_length);
        if (GetEnvironmentVariableW(variable_name, value.data(), required_length) == 0)
        {
            throw hresult_error(
                HRESULT_FROM_WIN32(GetLastError()),
                failure_context);
        }
        return std::filesystem::path(value.data());
    }

    std::filesystem::path resolve_known_folder_path(
        REFKNOWNFOLDERID folder_id,
        const wchar_t* failure_context)
    {
        PWSTR value = nullptr;
        const HRESULT result = SHGetKnownFolderPath(
            folder_id,
            KF_FLAG_DEFAULT,
            nullptr,
            &value);
        if (FAILED(result) || value == nullptr)
        {
            CoTaskMemFree(value);
            throw hresult_error(FAILED(result) ? result : E_UNEXPECTED, failure_context);
        }
        const std::filesystem::path path(value);
        CoTaskMemFree(value);
        return path;
    }

    std::wstring normalize_absolute_path(const std::filesystem::path& path)
    {
        const DWORD required_length = GetFullPathNameW(path.c_str(), 0, nullptr, nullptr);
        if (required_length == 0)
        {
            throw hresult_error(
                HRESULT_FROM_WIN32(GetLastError()),
                L"Unable to normalize a process path");
        }

        std::vector<wchar_t> value(required_length);
        if (GetFullPathNameW(
                path.c_str(),
                required_length,
                value.data(),
                nullptr) == 0)
        {
            throw hresult_error(
                HRESULT_FROM_WIN32(GetLastError()),
                L"Unable to normalize a process path");
        }

        std::wstring normalized(value.data());
        std::replace(normalized.begin(), normalized.end(), L'/', L'\\');
        while (normalized.size() > 3 && normalized.back() == L'\\')
        {
            normalized.pop_back();
        }
        std::transform(normalized.begin(), normalized.end(), normalized.begin(), [](wchar_t character)
        {
            return static_cast<wchar_t>(std::towlower(character));
        });
        return normalized;
    }

    bool is_path_within_directory(
        const std::filesystem::path& candidate_path,
        const std::filesystem::path& directory_path)
    {
        const std::wstring candidate = normalize_absolute_path(candidate_path);
        const std::wstring directory = normalize_absolute_path(directory_path);
        return candidate.size() > directory.size() &&
            candidate.compare(0, directory.size(), directory) == 0 &&
            candidate[directory.size()] == L'\\';
    }

    bool paths_overlap(
        const std::filesystem::path& first_path,
        const std::filesystem::path& second_path)
    {
        return normalize_absolute_path(first_path) == normalize_absolute_path(second_path) ||
            is_path_within_directory(first_path, second_path) ||
            is_path_within_directory(second_path, first_path);
    }

    bool is_windows_apps_path(const std::filesystem::path& candidate_path)
    {
        const DWORD required_length = GetEnvironmentVariableW(L"ProgramFiles", nullptr, 0);
        if (required_length == 0)
        {
            return false;
        }

        std::vector<wchar_t> program_files(required_length);
        if (GetEnvironmentVariableW(
                L"ProgramFiles",
                program_files.data(),
                required_length) == 0)
        {
            return false;
        }
        return is_path_within_directory(
            candidate_path,
            std::filesystem::path(program_files.data()) / L"WindowsApps");
    }

    bool current_process_has_package_identity()
    {
        UINT32 length = 0;
        const LONG result = GetCurrentPackageFullName(&length, nullptr);
        if (result == ERROR_INSUFFICIENT_BUFFER)
        {
            return true;
        }
        if (result == APPMODEL_ERROR_NO_PACKAGE)
        {
            return false;
        }
        throw hresult_error(
            HRESULT_FROM_WIN32(result),
            L"Unable to determine the current package identity");
    }

    std::filesystem::path current_executable_path()
    {
        std::vector<wchar_t> value(32768);
        const DWORD length = GetModuleFileNameW(
            nullptr,
            value.data(),
            static_cast<DWORD>(value.size()));
        if (length == 0 || length >= value.size())
        {
            throw hresult_error(
                HRESULT_FROM_WIN32(GetLastError()),
                L"Unable to resolve the Store update helper path");
        }
        return std::filesystem::path(std::wstring(value.data(), length));
    }

    constexpr wchar_t legacy_uninstall_key[] =
        L"Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\"
        L"886615f7-a04c-57ec-a2dd-9161dbe1a7c4";
    constexpr wchar_t legacy_installer_key[] =
        L"Software\\886615f7-a04c-57ec-a2dd-9161dbe1a7c4";

    std::string registry_target(
        const wchar_t* key_path,
        const wchar_t* value_name = nullptr)
    {
        std::string target = "HKCU\\" + utf8(key_path);
        if (value_name != nullptr)
        {
            target += "\\" + utf8(value_name);
        }
        return target;
    }

    void probe_legacy_registry_view(
        const wchar_t* key_path,
        const wchar_t* value_name,
        REGSAM view_access,
        const std::string& view_name) noexcept
    {
        HKEY key = nullptr;
        const LSTATUS open_result = RegOpenKeyExW(
            HKEY_CURRENT_USER,
            key_path,
            0,
            KEY_QUERY_VALUE | view_access,
            &key);
        const std::string target = registry_target(key_path, value_name);
        if (open_result != ERROR_SUCCESS)
        {
            append_legacy_cleanup_diagnostic(
                "authority-registry",
                open_result == ERROR_FILE_NOT_FOUND || open_result == ERROR_PATH_NOT_FOUND
                    ? "missing"
                    : "error",
                "registry-view-open",
                target,
                static_cast<DWORD>(open_result),
                HRESULT_FROM_WIN32(open_result),
                "view=" + view_name);
            return;
        }

        DWORD value_type = 0;
        DWORD value_bytes = 0;
        const LSTATUS query_result = RegQueryValueExW(
            key,
            value_name,
            nullptr,
            &value_type,
            nullptr,
            &value_bytes);
        RegCloseKey(key);
        append_legacy_cleanup_diagnostic(
            "authority-registry",
            query_result == ERROR_SUCCESS
                ? "present"
                : (query_result == ERROR_FILE_NOT_FOUND ? "value-missing" : "error"),
            "registry-view-query",
            target,
            static_cast<DWORD>(query_result),
            HRESULT_FROM_WIN32(query_result),
            "view=" + view_name +
                "; type=" + std::to_string(value_type) +
                "; bytes=" + std::to_string(value_bytes));
    }

    std::optional<std::wstring> read_current_user_registry_string(
        const wchar_t* key_path,
        const wchar_t* value_name,
        REGSAM view_access,
        const std::string& view_name)
    {
        HKEY key = nullptr;
        const LSTATUS open_result = RegOpenKeyExW(
            HKEY_CURRENT_USER,
            key_path,
            0,
            KEY_QUERY_VALUE | view_access,
            &key);
        append_legacy_cleanup_diagnostic(
            "authority-registry",
            open_result == ERROR_SUCCESS
                ? "opened"
                : (open_result == ERROR_FILE_NOT_FOUND || open_result == ERROR_PATH_NOT_FOUND
                    ? "missing"
                    : "error"),
            "registry-open",
            registry_target(key_path, value_name),
            static_cast<DWORD>(open_result),
            HRESULT_FROM_WIN32(open_result),
            "view=" + view_name + "; access=KEY_QUERY_VALUE");
        if (open_result == ERROR_FILE_NOT_FOUND || open_result == ERROR_PATH_NOT_FOUND)
        {
            return std::nullopt;
        }
        if (open_result != ERROR_SUCCESS)
        {
            throw hresult_error(
                HRESULT_FROM_WIN32(open_result),
                L"Unable to read the legacy Memmy installation authority");
        }

        DWORD type = 0;
        DWORD bytes = 0;
        LSTATUS result = RegQueryValueExW(
            key,
            value_name,
            nullptr,
            &type,
            nullptr,
            &bytes);
        append_legacy_cleanup_diagnostic(
            "authority-registry",
            result == ERROR_SUCCESS
                ? "queried-size"
                : (result == ERROR_FILE_NOT_FOUND ? "value-missing" : "error"),
            "registry-query-size",
            registry_target(key_path, value_name),
            static_cast<DWORD>(result),
            HRESULT_FROM_WIN32(result),
            "view=" + view_name + "; type=" + std::to_string(type) +
                "; bytes=" + std::to_string(bytes));
        if (result == ERROR_FILE_NOT_FOUND)
        {
            RegCloseKey(key);
            return std::nullopt;
        }
        if (result != ERROR_SUCCESS || (type != REG_SZ && type != REG_EXPAND_SZ))
        {
            RegCloseKey(key);
            throw hresult_error(
                result == ERROR_SUCCESS ? E_INVALIDARG : HRESULT_FROM_WIN32(result),
                L"Legacy Memmy installation authority contains an invalid registry value");
        }
        std::vector<wchar_t> value((bytes / sizeof(wchar_t)) + 1, L'\0');
        result = RegQueryValueExW(
            key,
            value_name,
            nullptr,
            &type,
            reinterpret_cast<BYTE*>(value.data()),
            &bytes);
        RegCloseKey(key);
        append_legacy_cleanup_diagnostic(
            "authority-registry",
            result == ERROR_SUCCESS ? "read" : "error",
            "registry-query-value",
            registry_target(key_path, value_name),
            static_cast<DWORD>(result),
            HRESULT_FROM_WIN32(result),
            result == ERROR_SUCCESS
                ? "view=" + view_name + "; value=" + utf8(value.data())
                : "view=" + view_name);
        if (result != ERROR_SUCCESS)
        {
            throw hresult_error(
                HRESULT_FROM_WIN32(result),
                L"Unable to read the legacy Memmy installation authority value");
        }
        return std::wstring(value.data());
    }

    bool path_is_missing(const std::filesystem::path& path)
    {
        const DWORD attributes = GetFileAttributesW(path.c_str());
        if (attributes != INVALID_FILE_ATTRIBUTES)
        {
            return false;
        }
        const DWORD error = GetLastError();
        if (error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND)
        {
            return true;
        }
        throw hresult_error(
            HRESULT_FROM_WIN32(error),
            L"Unable to inspect the legacy Memmy installation path");
    }

    bool validate_legacy_install_authority(
        const std::filesystem::path& legacy_install_directory,
        const std::filesystem::path& legacy_executable_path)
    {
        probe_legacy_registry_view(
            legacy_installer_key,
            L"InstallLocation",
            KEY_WOW64_32KEY,
            "32-bit");
        probe_legacy_registry_view(
            legacy_installer_key,
            L"InstallLocation",
            KEY_WOW64_64KEY,
            "64-bit");
        probe_legacy_registry_view(
            legacy_uninstall_key,
            L"InstallLocation",
            KEY_WOW64_32KEY,
            "32-bit");
        probe_legacy_registry_view(
            legacy_uninstall_key,
            L"InstallLocation",
            KEY_WOW64_64KEY,
            "64-bit");
        if (!legacy_install_directory.is_absolute() ||
            !legacy_executable_path.is_absolute() ||
            normalize_absolute_path(legacy_executable_path.parent_path()) !=
                normalize_absolute_path(legacy_install_directory) ||
            _wcsicmp(legacy_executable_path.filename().c_str(), L"Memmy.exe") != 0 ||
            normalize_absolute_path(legacy_install_directory) ==
                normalize_absolute_path(legacy_install_directory.root_path()) ||
            is_windows_apps_path(legacy_install_directory) ||
            is_windows_apps_path(legacy_executable_path))
        {
            throw hresult_invalid_argument(
                L"Refusing an unsafe legacy Memmy installation authority");
        }

        const std::filesystem::path store_control_directory =
            resolve_known_folder_path(
                FOLDERID_LocalAppData,
                L"The current user's Local AppData directory is unavailable for legacy cleanup") /
            L"Memmy";
        if (paths_overlap(legacy_install_directory, store_control_directory))
        {
            throw hresult_invalid_argument(
                L"Refusing a legacy Memmy install path that overlaps the Store transition control directory");
        }

        const auto recorded_install_directory_32 = read_current_user_registry_string(
            legacy_installer_key,
            L"InstallLocation",
            KEY_WOW64_32KEY,
            "32-bit");
        const auto recorded_install_directory_64 = read_current_user_registry_string(
            legacy_installer_key,
            L"InstallLocation",
            KEY_WOW64_64KEY,
            "64-bit");
        const bool install_missing = path_is_missing(legacy_install_directory);
        if (!recorded_install_directory_32 && !recorded_install_directory_64)
        {
            if (install_missing)
            {
                return false;
            }
            throw hresult_invalid_argument(
                L"Legacy Memmy install directory has no matching uninstall authority");
        }
        const std::wstring normalized_install_directory =
            normalize_absolute_path(legacy_install_directory);
        const auto authority_matches = [&](const std::optional<std::wstring>& recorded)
        {
            return !recorded || normalize_absolute_path(*recorded) == normalized_install_directory;
        };
        if (!authority_matches(recorded_install_directory_32) ||
            !authority_matches(recorded_install_directory_64))
        {
            throw hresult_invalid_argument(
                L"Legacy Memmy install directory does not match the uninstall authority");
        }
        if (install_missing)
        {
            return false;
        }

        const DWORD directory_attributes = GetFileAttributesW(legacy_install_directory.c_str());
        const DWORD executable_attributes = GetFileAttributesW(legacy_executable_path.c_str());
        if ((directory_attributes & FILE_ATTRIBUTE_DIRECTORY) == 0 ||
            (directory_attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0 ||
            executable_attributes == INVALID_FILE_ATTRIBUTES ||
            (executable_attributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) != 0)
        {
            throw hresult_invalid_argument(
                L"Legacy Memmy installation authority is not a regular directory and executable");
        }
        return true;
    }

    ULONGLONG query_process_creation_time(HANDLE process)
    {
        FILETIME creation{};
        FILETIME exit{};
        FILETIME kernel{};
        FILETIME user{};
        if (!GetProcessTimes(process, &creation, &exit, &kernel, &user))
        {
            return 0;
        }
        ULARGE_INTEGER value{};
        value.LowPart = creation.dwLowDateTime;
        value.HighPart = creation.dwHighDateTime;
        return value.QuadPart;
    }

    ULONGLONG query_process_creation_time(DWORD process_id)
    {
        const HANDLE process = OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION,
            FALSE,
            process_id);
        if (!process)
        {
            return 0;
        }
        const ULONGLONG result = query_process_creation_time(process);
        CloseHandle(process);
        return result;
    }

    std::vector<ProcessSnapshotEntry> snapshot_processes()
    {
        const HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if (snapshot == INVALID_HANDLE_VALUE)
        {
            throw hresult_error(
                HRESULT_FROM_WIN32(GetLastError()),
                L"Unable to enumerate processes for legacy takeover");
        }
        std::vector<ProcessSnapshotEntry> processes;
        PROCESSENTRY32W entry{};
        entry.dwSize = sizeof(entry);
        if (!Process32FirstW(snapshot, &entry))
        {
            const DWORD error = GetLastError();
            CloseHandle(snapshot);
            throw hresult_error(
                HRESULT_FROM_WIN32(error),
                L"Unable to read the process snapshot for legacy takeover");
        }
        do
        {
            processes.push_back({
                entry.th32ProcessID,
                entry.th32ParentProcessID,
                query_process_creation_time(entry.th32ProcessID)
            });
        } while (Process32NextW(snapshot, &entry));
        CloseHandle(snapshot);
        return processes;
    }

    bool try_query_process_image_path(
        HANDLE process,
        std::filesystem::path& image_path)
    {
        std::vector<wchar_t> value(32768);
        DWORD length = static_cast<DWORD>(value.size());
        const BOOL result = QueryFullProcessImageNameW(
            process,
            0,
            value.data(),
            &length);
        if (!result || length == 0)
        {
            return false;
        }
        image_path = std::filesystem::path(std::wstring(value.data(), length));
        return true;
    }

    bool try_query_process_image_path(
        DWORD process_id,
        std::filesystem::path& image_path)
    {
        const HANDLE process = OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION,
            FALSE,
            process_id);
        if (!process)
        {
            return false;
        }
        const bool result = try_query_process_image_path(process, image_path);
        CloseHandle(process);
        return result;
    }

    std::vector<ProcessSnapshotEntry> find_legacy_process_tree(
        const std::filesystem::path& legacy_install_directory)
    {
        std::vector<ProcessSnapshotEntry> processes = snapshot_processes();
        std::unordered_set<DWORD> target_process_ids;
        const DWORD current_process_id = GetCurrentProcessId();
        for (auto& process : processes)
        {
            if (process.process_id == 0 ||
                process.process_id == current_process_id ||
                process.creation_time == 0)
            {
                continue;
            }
            process.image_path_verified =
                try_query_process_image_path(process.process_id, process.image_path);
            if (process.image_path_verified &&
                !is_windows_apps_path(process.image_path) &&
                is_path_within_directory(process.image_path, legacy_install_directory))
            {
                target_process_ids.insert(process.process_id);
            }
        }

        std::unordered_map<DWORD, ProcessSnapshotEntry> processes_by_id;
        for (const auto& process : processes)
        {
            processes_by_id.emplace(process.process_id, process);
        }
        bool added_descendant = true;
        while (added_descendant)
        {
            added_descendant = false;
            for (const auto& process : processes)
            {
                if (target_process_ids.contains(process.process_id) ||
                    !target_process_ids.contains(process.parent_process_id))
                {
                    continue;
                }
                const auto parent = processes_by_id.find(process.parent_process_id);
                if (parent == processes_by_id.end() ||
                    process.creation_time == 0 ||
                    parent->second.creation_time == 0 ||
                    process.creation_time < parent->second.creation_time ||
                    !process.image_path_verified ||
                    is_windows_apps_path(process.image_path) ||
                    !is_path_within_directory(process.image_path, legacy_install_directory))
                {
                    continue;
                }
                target_process_ids.insert(process.process_id);
                added_descendant = true;
            }
        }

        std::unordered_map<DWORD, DWORD> parent_process_ids;
        for (const auto& process : processes)
        {
            parent_process_ids.emplace(process.process_id, process.parent_process_id);
        }
        const auto process_depth = [&parent_process_ids, &target_process_ids](DWORD process_id)
        {
            size_t depth = 0;
            std::unordered_set<DWORD> visited;
            auto current = process_id;
            while (visited.insert(current).second)
            {
                const auto parent = parent_process_ids.find(current);
                if (parent == parent_process_ids.end() ||
                    !target_process_ids.contains(parent->second))
                {
                    break;
                }
                ++depth;
                current = parent->second;
            }
            return depth;
        };

        std::vector<ProcessSnapshotEntry> targets;
        std::copy_if(
            processes.begin(),
            processes.end(),
            std::back_inserter(targets),
            [&target_process_ids](const ProcessSnapshotEntry& process)
            {
                return target_process_ids.contains(process.process_id);
            });
        std::sort(targets.begin(), targets.end(), [&process_depth](
            const ProcessSnapshotEntry& left,
            const ProcessSnapshotEntry& right)
        {
            return process_depth(left.process_id) > process_depth(right.process_id);
        });
        return targets;
    }

    BOOL CALLBACK close_legacy_window(HWND window, LPARAM parameter)
    {
        const auto* process_ids =
            reinterpret_cast<const std::unordered_set<DWORD>*>(parameter);
        DWORD process_id = 0;
        GetWindowThreadProcessId(window, &process_id);
        if (!process_ids->contains(process_id))
        {
            return TRUE;
        }
        DWORD_PTR ignored = 0;
        SendMessageTimeoutW(
            window,
            WM_CLOSE,
            0,
            0,
            SMTO_ABORTIFHUNG | SMTO_BLOCK,
            1000,
            &ignored);
        return TRUE;
    }

    void request_graceful_legacy_exit(
        const std::vector<ProcessSnapshotEntry>& targets)
    {
        std::unordered_set<DWORD> process_ids;
        for (const auto& target : targets)
        {
            process_ids.insert(target.process_id);
        }
        EnumWindows(
            close_legacy_window,
            reinterpret_cast<LPARAM>(&process_ids));
    }

    bool wait_for_process_snapshot_to_exit(
        const std::vector<ProcessSnapshotEntry>& targets,
        DWORD timeout_ms)
    {
        const ULONGLONG deadline = GetTickCount64() + timeout_ms;
        do
        {
            bool any_running = false;
            for (const auto& target : targets)
            {
                const HANDLE process = OpenProcess(
                    SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION,
                    FALSE,
                    target.process_id);
                if (!process)
                {
                    continue;
                }
                any_running =
                    target.creation_time != 0 &&
                    query_process_creation_time(process) == target.creation_time &&
                    WaitForSingleObject(process, 0) == WAIT_TIMEOUT;
                CloseHandle(process);
                if (any_running)
                {
                    break;
                }
            }
            if (!any_running)
            {
                return true;
            }
            Sleep(100);
        } while (GetTickCount64() < deadline);
        return false;
    }

    void terminate_legacy_process_tree(
        const std::vector<ProcessSnapshotEntry>& targets)
    {
        for (const auto& target : targets)
        {
            const HANDLE process = OpenProcess(
                PROCESS_TERMINATE | SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION,
                FALSE,
                target.process_id);
            if (!process)
            {
                const DWORD error = GetLastError();
                if (error == ERROR_INVALID_PARAMETER)
                {
                    continue;
                }
                throw hresult_error(
                    HRESULT_FROM_WIN32(error),
                    L"Unable to open a validated legacy Memmy process");
            }
            if (target.creation_time == 0 ||
                query_process_creation_time(process) != target.creation_time ||
                WaitForSingleObject(process, 0) != WAIT_TIMEOUT)
            {
                CloseHandle(process);
                continue;
            }
            std::filesystem::path current_image_path;
            if (!try_query_process_image_path(process, current_image_path))
            {
                const DWORD error = GetLastError();
                CloseHandle(process);
                throw hresult_error(
                    HRESULT_FROM_WIN32(error == ERROR_SUCCESS ? ERROR_ACCESS_DENIED : error),
                    L"Unable to revalidate a legacy Memmy process image path");
            }
            if (!target.image_path_verified ||
                is_windows_apps_path(current_image_path) ||
                normalize_absolute_path(current_image_path) !=
                    normalize_absolute_path(target.image_path))
            {
                CloseHandle(process);
                continue;
            }
            if (!TerminateProcess(process, 0))
            {
                const DWORD error = GetLastError();
                CloseHandle(process);
                throw hresult_error(
                    HRESULT_FROM_WIN32(error),
                    L"Unable to terminate a validated legacy Memmy process");
            }
            WaitForSingleObject(process, 3000);
            CloseHandle(process);
        }
    }

    void stop_legacy_processes(const std::filesystem::path& legacy_install_directory)
    {
        constexpr int maximum_scan_rounds = 8;
        constexpr int required_empty_rounds = 3;
        int empty_rounds = 0;
        for (int round = 0; round < maximum_scan_rounds; ++round)
        {
            const auto targets = find_legacy_process_tree(legacy_install_directory);
            if (targets.empty())
            {
                ++empty_rounds;
                if (empty_rounds >= required_empty_rounds)
                {
                    return;
                }
                Sleep(150);
                continue;
            }
            empty_rounds = 0;
            request_graceful_legacy_exit(targets);
            if (!wait_for_process_snapshot_to_exit(targets, 2000))
            {
                terminate_legacy_process_tree(targets);
                wait_for_process_snapshot_to_exit(targets, 1000);
            }
        }
        if (!find_legacy_process_tree(legacy_install_directory).empty())
        {
            throw hresult_error(
                HRESULT_FROM_WIN32(ERROR_BUSY),
                L"Legacy Memmy processes restarted during Store takeover");
        }
    }

    void prepare_legacy_takeover(const LegacyTransitionOptions& options)
    {
        if (!validate_legacy_install_authority(
                options.legacy_install_directory,
                options.legacy_executable_path))
        {
            return;
        }
        stop_legacy_processes(options.legacy_install_directory);
    }

    std::wstring quote_command_line_argument(const std::wstring& value)
    {
        if (!value.empty() && value.find_first_of(L" \t\n\v\"") == std::wstring::npos)
        {
            return value;
        }

        std::wstring quoted(1, L'\"');
        size_t backslash_count = 0;
        for (const wchar_t character : value)
        {
            if (character == L'\\')
            {
                ++backslash_count;
                continue;
            }
            if (character == L'\"')
            {
                quoted.append(backslash_count * 2 + 1, L'\\');
                quoted.push_back(character);
                backslash_count = 0;
                continue;
            }
            quoted.append(backslash_count, L'\\');
            backslash_count = 0;
            quoted.push_back(character);
        }
        quoted.append(backslash_count * 2, L'\\');
        quoted.push_back(L'\"');
        return quoted;
    }

    DeleteTreeResult delete_tree_failure(
        DWORD win32_error,
        const std::filesystem::path& failed_path,
        const std::string& operation)
    {
        return { win32_error, failed_path, operation };
    }

    DeleteTreeResult delete_directory_tree_once(const std::filesystem::path& path)
    {
        const DWORD attributes = GetFileAttributesW(path.c_str());
        if (attributes == INVALID_FILE_ATTRIBUTES)
        {
            const DWORD error = GetLastError();
            return error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND
                ? DeleteTreeResult{}
                : delete_tree_failure(error, path, "GetFileAttributesW");
        }
        if ((attributes & FILE_ATTRIBUTE_READONLY) != 0 &&
            !SetFileAttributesW(path.c_str(), attributes & ~FILE_ATTRIBUTE_READONLY))
        {
            const DWORD error = GetLastError();
            append_legacy_cleanup_diagnostic(
                "install-directory-delete",
                "attribute-clear-error-ignored",
                "SetFileAttributesW",
                utf8(path.wstring()),
                error,
                HRESULT_FROM_WIN32(error));
        }
        if ((attributes & FILE_ATTRIBUTE_DIRECTORY) == 0)
        {
            if (DeleteFileW(path.c_str()))
            {
                return {};
            }
            return delete_tree_failure(GetLastError(), path, "DeleteFileW");
        }
        if ((attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0)
        {
            if (RemoveDirectoryW(path.c_str()))
            {
                return {};
            }
            return delete_tree_failure(GetLastError(), path, "RemoveDirectoryW(reparse-point)");
        }

        WIN32_FIND_DATAW entry{};
        HANDLE search = FindFirstFileW((path / L"*").c_str(), &entry);
        if (search == INVALID_HANDLE_VALUE)
        {
            const DWORD error = GetLastError();
            if (error != ERROR_FILE_NOT_FOUND)
            {
                return delete_tree_failure(error, path, "FindFirstFileW");
            }
            if (RemoveDirectoryW(path.c_str()))
            {
                return {};
            }
            const DWORD remove_error = GetLastError();
            return remove_error == ERROR_FILE_NOT_FOUND || remove_error == ERROR_PATH_NOT_FOUND
                ? DeleteTreeResult{}
                : delete_tree_failure(remove_error, path, "RemoveDirectoryW(empty-directory)");
        }
        DeleteTreeResult result;
        do
        {
            if (wcscmp(entry.cFileName, L".") == 0 || wcscmp(entry.cFileName, L"..") == 0)
            {
                continue;
            }
            result = delete_directory_tree_once(path / entry.cFileName);
            if (result.win32_error != ERROR_SUCCESS)
            {
                break;
            }
        } while (FindNextFileW(search, &entry));
        if (result.win32_error == ERROR_SUCCESS)
        {
            const DWORD enumeration_error = GetLastError();
            if (enumeration_error != ERROR_NO_MORE_FILES)
            {
                result = delete_tree_failure(enumeration_error, path, "FindNextFileW");
            }
        }
        FindClose(search);
        if (result.win32_error != ERROR_SUCCESS)
        {
            return result;
        }
        if (RemoveDirectoryW(path.c_str()))
        {
            return {};
        }
        return delete_tree_failure(GetLastError(), path, "RemoveDirectoryW");
    }

    void remove_legacy_install_directory(const LegacyTransitionOptions& options)
    {
        DeleteTreeResult result;
        constexpr int maximum_attempts = 20;
        for (int attempt = 0; attempt < maximum_attempts; ++attempt)
        {
            if (attempt > 0)
            {
                // Files may already be partially removed, including Memmy.exe. The
                // authority was validated before deletion began, so retries must not
                // require the executable to remain present.
                stop_legacy_processes(options.legacy_install_directory);
            }
            result = delete_directory_tree_once(options.legacy_install_directory);
            append_legacy_cleanup_diagnostic(
                "install-directory-delete",
                result.win32_error == ERROR_SUCCESS ? "success" : "retryable-error",
                result.operation.empty() ? "delete-directory-tree" : result.operation,
                result.failed_path.empty()
                    ? utf8(options.legacy_install_directory.wstring())
                    : utf8(result.failed_path.wstring()),
                result.win32_error,
                HRESULT_FROM_WIN32(result.win32_error),
                "attempt=" + std::to_string(attempt + 1));
            if (result.win32_error == ERROR_SUCCESS)
            {
                return;
            }
            Sleep(250);
        }
        set_legacy_cleanup_failure_context(
            result.operation.empty() ? "delete-directory-tree" : result.operation,
            result.failed_path.empty()
                ? utf8(options.legacy_install_directory.wstring())
                : utf8(result.failed_path.wstring()),
            result.win32_error);
        throw hresult_error(
            HRESULT_FROM_WIN32(result.win32_error),
            to_hstring(
                "Unable to remove the authority-bound legacy Memmy install directory; operation=" +
                result.operation + "; path=" + utf8(result.failed_path.wstring())));
    }

    void delete_registry_tree_if_present(
        const wchar_t* key_path,
        REGSAM view_access,
        const std::string& view_name)
    {
        const std::string event = wcscmp(key_path, legacy_uninstall_key) == 0
            ? "uninstall-registry-delete"
            : "installer-authority-registry-delete";
        HKEY key = nullptr;
        const LSTATUS open_result = RegOpenKeyExW(
            HKEY_CURRENT_USER,
            key_path,
            0,
            DELETE | KEY_ENUMERATE_SUB_KEYS | KEY_QUERY_VALUE | KEY_SET_VALUE | view_access,
            &key);
        append_legacy_cleanup_diagnostic(
            event,
            open_result == ERROR_SUCCESS
                ? "opened"
                : (open_result == ERROR_FILE_NOT_FOUND || open_result == ERROR_PATH_NOT_FOUND
                    ? "already-missing"
                    : "error"),
            "RegOpenKeyExW(delete)",
            registry_target(key_path),
            static_cast<DWORD>(open_result),
            HRESULT_FROM_WIN32(open_result),
            "view=" + view_name);
        if (open_result == ERROR_FILE_NOT_FOUND || open_result == ERROR_PATH_NOT_FOUND)
        {
            return;
        }
        if (open_result != ERROR_SUCCESS)
        {
            set_legacy_cleanup_failure_context(
                "RegOpenKeyExW(delete)",
                registry_target(key_path),
                static_cast<DWORD>(open_result));
            throw hresult_error(
                HRESULT_FROM_WIN32(open_result),
                to_hstring(
                    "Unable to open the legacy registry tree for deletion; view=" +
                    view_name + "; key=" + registry_target(key_path)));
        }

        const LSTATUS tree_result = RegDeleteTreeW(key, nullptr);
        RegCloseKey(key);
        append_legacy_cleanup_diagnostic(
            event,
            tree_result == ERROR_SUCCESS
                ? "contents-deleted"
                : (tree_result == ERROR_FILE_NOT_FOUND || tree_result == ERROR_PATH_NOT_FOUND
                    ? "contents-already-missing"
                    : "error"),
            "RegDeleteTreeW",
            registry_target(key_path),
            static_cast<DWORD>(tree_result),
            HRESULT_FROM_WIN32(tree_result),
            "view=" + view_name + "; subKey=null");
        if (tree_result != ERROR_SUCCESS &&
            tree_result != ERROR_FILE_NOT_FOUND &&
            tree_result != ERROR_PATH_NOT_FOUND)
        {
            set_legacy_cleanup_failure_context(
                "RegDeleteTreeW",
                registry_target(key_path),
                static_cast<DWORD>(tree_result));
            throw hresult_error(
                HRESULT_FROM_WIN32(tree_result),
                to_hstring(
                    "Unable to delete the legacy registry tree contents; view=" +
                    view_name + "; key=" + registry_target(key_path)));
        }

        const LSTATUS delete_result = RegDeleteKeyExW(
            HKEY_CURRENT_USER,
            key_path,
            view_access,
            0);
        append_legacy_cleanup_diagnostic(
            event,
            delete_result == ERROR_SUCCESS
                ? "success"
                : (delete_result == ERROR_FILE_NOT_FOUND || delete_result == ERROR_PATH_NOT_FOUND
                    ? "already-missing"
                    : "error"),
            "RegDeleteKeyExW",
            registry_target(key_path),
            static_cast<DWORD>(delete_result),
            HRESULT_FROM_WIN32(delete_result),
            "view=" + view_name);
        if (delete_result != ERROR_SUCCESS &&
            delete_result != ERROR_FILE_NOT_FOUND &&
            delete_result != ERROR_PATH_NOT_FOUND)
        {
            set_legacy_cleanup_failure_context(
                "RegDeleteKeyExW",
                registry_target(key_path),
                static_cast<DWORD>(delete_result));
            throw hresult_error(
                HRESULT_FROM_WIN32(delete_result),
                to_hstring(
                    "Unable to delete the legacy registry key; view=" +
                    view_name + "; key=" + registry_target(key_path)));
        }
    }

    bool registry_tree_exists(
        const wchar_t* key_path,
        REGSAM view_access,
        const std::string& view_name)
    {
        HKEY key = nullptr;
        const LSTATUS result = RegOpenKeyExW(
            HKEY_CURRENT_USER,
            key_path,
            0,
            KEY_READ | view_access,
            &key);
        append_legacy_cleanup_diagnostic(
            wcscmp(key_path, legacy_uninstall_key) == 0
                ? "uninstall-registry-delete"
                : "installer-authority-registry-delete",
            result == ERROR_SUCCESS
                ? "still-present"
                : (result == ERROR_FILE_NOT_FOUND || result == ERROR_PATH_NOT_FOUND
                    ? "verified-missing"
                    : "verify-error"),
            "RegOpenKeyExW(post-check)",
            registry_target(key_path),
            static_cast<DWORD>(result),
            HRESULT_FROM_WIN32(result),
            "view=" + view_name);
        if (result == ERROR_SUCCESS)
        {
            RegCloseKey(key);
            return true;
        }
        if (result == ERROR_FILE_NOT_FOUND || result == ERROR_PATH_NOT_FOUND)
        {
            return false;
        }
        set_legacy_cleanup_failure_context(
            "RegOpenKeyExW(post-check)",
            registry_target(key_path),
            static_cast<DWORD>(result));
        throw hresult_error(
            HRESULT_FROM_WIN32(result),
            L"Unable to verify the legacy registry cleanup");
    }

    void delete_registry_value_if_present(const wchar_t* key_path, const wchar_t* value_name)
    {
        HKEY key = nullptr;
        const LSTATUS open_result = RegOpenKeyExW(
            HKEY_CURRENT_USER,
            key_path,
            0,
            KEY_SET_VALUE,
            &key);
        append_legacy_cleanup_diagnostic(
            "run-registry-delete",
            open_result == ERROR_SUCCESS
                ? "opened"
                : (open_result == ERROR_FILE_NOT_FOUND || open_result == ERROR_PATH_NOT_FOUND
                    ? "key-missing"
                    : "open-error"),
            "RegOpenKeyExW",
            registry_target(key_path, value_name),
            static_cast<DWORD>(open_result),
            HRESULT_FROM_WIN32(open_result),
            "view=process-default; access=KEY_SET_VALUE");
        if (open_result == ERROR_FILE_NOT_FOUND || open_result == ERROR_PATH_NOT_FOUND)
        {
            return;
        }
        if (open_result != ERROR_SUCCESS)
        {
            check_hresult(HRESULT_FROM_WIN32(open_result));
        }
        const LSTATUS delete_result = RegDeleteValueW(key, value_name);
        RegCloseKey(key);
        append_legacy_cleanup_diagnostic(
            "run-registry-delete",
            delete_result == ERROR_SUCCESS
                ? "success"
                : (delete_result == ERROR_FILE_NOT_FOUND ? "already-missing" : "error"),
            "RegDeleteValueW",
            registry_target(key_path, value_name),
            static_cast<DWORD>(delete_result),
            HRESULT_FROM_WIN32(delete_result),
            "view=process-default");
        if (delete_result != ERROR_SUCCESS && delete_result != ERROR_FILE_NOT_FOUND)
        {
            check_hresult(HRESULT_FROM_WIN32(delete_result));
        }
    }

    std::wstring normalize_path_component(std::wstring value)
    {
        while (!value.empty() && std::iswspace(value.front()))
        {
            value.erase(value.begin());
        }
        while (!value.empty() && std::iswspace(value.back()))
        {
            value.pop_back();
        }
        if (value.size() >= 2 && value.front() == L'\"' && value.back() == L'\"')
        {
            value = value.substr(1, value.size() - 2);
        }
        std::replace(value.begin(), value.end(), L'/', L'\\');
        while (!value.empty() && value.back() == L'\\')
        {
            value.pop_back();
        }
        std::transform(value.begin(), value.end(), value.begin(), [](wchar_t character)
        {
            return static_cast<wchar_t>(std::towlower(character));
        });
        return value;
    }

    void remove_legacy_cli_from_user_path(
        const std::filesystem::path& legacy_install_directory)
    {
        const std::wstring target = normalize_path_component(
            (legacy_install_directory / L"resources" / L"cli").wstring());
        HKEY environment_key = nullptr;
        const LSTATUS open_result = RegOpenKeyExW(
            HKEY_CURRENT_USER,
            L"Environment",
            0,
            KEY_QUERY_VALUE | KEY_SET_VALUE,
            &environment_key);
        append_legacy_cleanup_diagnostic(
            "user-path-update",
            open_result == ERROR_SUCCESS
                ? "opened"
                : (open_result == ERROR_FILE_NOT_FOUND || open_result == ERROR_PATH_NOT_FOUND
                    ? "key-missing"
                    : "open-error"),
            "RegOpenKeyExW",
            "HKCU\\Environment\\Path",
            static_cast<DWORD>(open_result),
            HRESULT_FROM_WIN32(open_result));
        if (open_result == ERROR_FILE_NOT_FOUND || open_result == ERROR_PATH_NOT_FOUND)
        {
            return;
        }
        if (open_result != ERROR_SUCCESS)
        {
            check_hresult(HRESULT_FROM_WIN32(open_result));
        }
        DWORD value_type = 0;
        DWORD value_size = 0;
        LSTATUS read_result = RegQueryValueExW(
            environment_key,
            L"Path",
            nullptr,
            &value_type,
            nullptr,
            &value_size);
        append_legacy_cleanup_diagnostic(
            "user-path-update",
            read_result == ERROR_SUCCESS
                ? "queried-size"
                : (read_result == ERROR_FILE_NOT_FOUND ? "value-missing" : "query-error"),
            "RegQueryValueExW(size)",
            "HKCU\\Environment\\Path",
            static_cast<DWORD>(read_result),
            HRESULT_FROM_WIN32(read_result),
            "type=" + std::to_string(value_type) + "; bytes=" + std::to_string(value_size));
        if (read_result == ERROR_FILE_NOT_FOUND)
        {
            RegCloseKey(environment_key);
            return;
        }
        if (read_result != ERROR_SUCCESS ||
            (value_type != REG_SZ && value_type != REG_EXPAND_SZ))
        {
            RegCloseKey(environment_key);
            if (read_result != ERROR_SUCCESS)
            {
                check_hresult(HRESULT_FROM_WIN32(read_result));
            }
            return;
        }
        std::vector<wchar_t> buffer((value_size / sizeof(wchar_t)) + 1, L'\0');
        read_result = RegQueryValueExW(
            environment_key,
            L"Path",
            nullptr,
            &value_type,
            reinterpret_cast<BYTE*>(buffer.data()),
            &value_size);
        append_legacy_cleanup_diagnostic(
            "user-path-update",
            read_result == ERROR_SUCCESS ? "read" : "query-error",
            "RegQueryValueExW(value)",
            "HKCU\\Environment\\Path",
            static_cast<DWORD>(read_result),
            HRESULT_FROM_WIN32(read_result));
        if (read_result != ERROR_SUCCESS)
        {
            RegCloseKey(environment_key);
            check_hresult(HRESULT_FROM_WIN32(read_result));
        }

        const std::wstring original(buffer.data());
        std::wstring filtered;
        size_t start = 0;
        while (start <= original.size())
        {
            const size_t separator = original.find(L';', start);
            const std::wstring component = original.substr(
                start,
                separator == std::wstring::npos ? std::wstring::npos : separator - start);
            if (!component.empty() && normalize_path_component(component) != target)
            {
                if (!filtered.empty())
                {
                    filtered += L';';
                }
                filtered += component;
            }
            if (separator == std::wstring::npos)
            {
                break;
            }
            start = separator + 1;
        }
        if (filtered != original)
        {
            const DWORD bytes = static_cast<DWORD>((filtered.size() + 1) * sizeof(wchar_t));
            const LSTATUS write_result = RegSetValueExW(
                environment_key,
                L"Path",
                0,
                value_type,
                reinterpret_cast<const BYTE*>(filtered.c_str()),
                bytes);
            RegCloseKey(environment_key);
            append_legacy_cleanup_diagnostic(
                "user-path-update",
                write_result == ERROR_SUCCESS ? "success" : "write-error",
                "RegSetValueExW",
                "HKCU\\Environment\\Path",
                static_cast<DWORD>(write_result),
                HRESULT_FROM_WIN32(write_result));
            if (write_result != ERROR_SUCCESS)
            {
                check_hresult(HRESULT_FROM_WIN32(write_result));
            }
            DWORD_PTR ignored = 0;
            const LRESULT broadcast_result = SendMessageTimeoutW(
                HWND_BROADCAST,
                WM_SETTINGCHANGE,
                0,
                reinterpret_cast<LPARAM>(L"Environment"),
                SMTO_ABORTIFHUNG,
                5000,
                &ignored);
            const DWORD broadcast_error = broadcast_result == 0 ? GetLastError() : ERROR_SUCCESS;
            append_legacy_cleanup_diagnostic(
                "user-path-update",
                broadcast_result != 0 ? "broadcast-success" : "broadcast-error-ignored",
                "SendMessageTimeoutW",
                "WM_SETTINGCHANGE:Environment",
                broadcast_error,
                HRESULT_FROM_WIN32(broadcast_error));
            return;
        }
        RegCloseKey(environment_key);
        append_legacy_cleanup_diagnostic(
            "user-path-update",
            "unchanged",
            "filter-path",
            utf8((legacy_install_directory / L"resources" / L"cli").wstring()));
    }

    void create_apps_folder_shortcut(
        const std::filesystem::path& shortcut_path,
        const std::wstring& aumid)
    {
        com_ptr<IShellItem> apps_folder;
        const HRESULT apps_folder_result = SHGetKnownFolderItem(
            FOLDERID_AppsFolder,
            KF_FLAG_DEFAULT,
            nullptr,
            IID_PPV_ARGS(apps_folder.put()));
        append_legacy_cleanup_diagnostic(
            "apps-folder-shortcut-create",
            SUCCEEDED(apps_folder_result) ? "success" : "error",
            "SHGetKnownFolderItem",
            "AppsFolder",
            std::nullopt,
            apps_folder_result);
        if (FAILED(apps_folder_result))
        {
            set_legacy_cleanup_failure_context("SHGetKnownFolderItem", "AppsFolder");
        }
        check_hresult(apps_folder_result);
        com_ptr<IShellItem> application_item;
        const HRESULT application_item_result = SHCreateItemFromRelativeName(
            apps_folder.get(),
            aumid.c_str(),
            nullptr,
            IID_PPV_ARGS(application_item.put()));
        append_legacy_cleanup_diagnostic(
            "apps-folder-shortcut-create",
            SUCCEEDED(application_item_result) ? "success" : "error",
            "SHCreateItemFromRelativeName",
            utf8(aumid),
            std::nullopt,
            application_item_result);
        if (FAILED(application_item_result))
        {
            set_legacy_cleanup_failure_context(
                "SHCreateItemFromRelativeName",
                utf8(aumid));
        }
        check_hresult(application_item_result);
        PIDLIST_ABSOLUTE full_item_id = nullptr;
        const HRESULT item_id_result = SHGetIDListFromObject(application_item.get(), &full_item_id);
        append_legacy_cleanup_diagnostic(
            "apps-folder-shortcut-create",
            SUCCEEDED(item_id_result) ? "success" : "error",
            "SHGetIDListFromObject",
            utf8(aumid),
            std::nullopt,
            item_id_result);
        if (FAILED(item_id_result))
        {
            set_legacy_cleanup_failure_context(
                "SHGetIDListFromObject",
                utf8(aumid));
        }
        check_hresult(item_id_result);
        if (full_item_id == nullptr)
        {
            set_legacy_cleanup_failure_context(
                "SHGetIDListFromObject",
                utf8(aumid));
            throw hresult_error(
                E_UNEXPECTED,
                L"Windows returned an empty AppsFolder item identifier");
        }
        const PCUITEMID_CHILD child_item = ILFindLastID(full_item_id);
        PIDLIST_ABSOLUTE parent_item_id =
            reinterpret_cast<PIDLIST_ABSOLUTE>(ILClone(full_item_id));
        if (!parent_item_id)
        {
            CoTaskMemFree(full_item_id);
            throw hresult_error(E_OUTOFMEMORY, L"Unable to clone the AppsFolder item identifier");
        }
        if (!ILRemoveLastID(parent_item_id))
        {
            CoTaskMemFree(parent_item_id);
            CoTaskMemFree(full_item_id);
            throw hresult_error(E_FAIL, L"Unable to resolve the AppsFolder item parent");
        }
        com_ptr<IDataObject> data_object;
        PCUITEMID_CHILD children[] = { child_item };
        const HRESULT data_result = SHCreateDataObject(
            parent_item_id,
            1,
            children,
            nullptr,
            IID_PPV_ARGS(data_object.put()));
        CoTaskMemFree(parent_item_id);
        CoTaskMemFree(full_item_id);
        append_legacy_cleanup_diagnostic(
            "apps-folder-shortcut-create",
            SUCCEEDED(data_result) ? "success" : "error",
            "SHCreateDataObject",
            utf8(aumid),
            std::nullopt,
            data_result);
        if (FAILED(data_result))
        {
            set_legacy_cleanup_failure_context(
                "SHCreateDataObject",
                utf8(aumid));
        }
        check_hresult(data_result);
        using CreateLinksFunction =
            HRESULT(WINAPI*)(HWND, LPCWSTR, IDataObject*, UINT, PIDLIST_ABSOLUTE*);
        const HMODULE shell_module = GetModuleHandleW(L"shell32.dll");
        const auto create_links = shell_module
            ? reinterpret_cast<CreateLinksFunction>(
                GetProcAddress(shell_module, MAKEINTRESOURCEA(172)))
            : nullptr;
        if (!create_links)
        {
            set_legacy_cleanup_failure_context(
                "GetProcAddress(SHCreateLinks)",
                "shell32.dll ordinal 172",
                ERROR_PROC_NOT_FOUND);
            throw hresult_error(
                HRESULT_FROM_WIN32(ERROR_PROC_NOT_FOUND),
                L"Windows shell link creation is unavailable");
        }
        std::error_code remove_error;
        std::filesystem::remove(shortcut_path, remove_error);
        append_legacy_cleanup_diagnostic(
            "apps-folder-shortcut-create",
            remove_error ? "existing-shortcut-remove-error" : "existing-shortcut-removed-or-missing",
            "std::filesystem::remove",
            utf8(shortcut_path.wstring()),
            remove_error ? std::optional<DWORD>(static_cast<DWORD>(remove_error.value())) : std::nullopt,
            remove_error
                ? std::optional<HRESULT>(HRESULT_FROM_WIN32(remove_error.value()))
                : std::nullopt);
        if (remove_error)
        {
            const DWORD error = static_cast<DWORD>(remove_error.value());
            set_legacy_cleanup_failure_context(
                "std::filesystem::remove",
                utf8(shortcut_path.wstring()),
                error);
            throw hresult_error(
                HRESULT_FROM_WIN32(error),
                L"Unable to remove the existing Memmy desktop shortcut");
        }
        PIDLIST_ABSOLUTE created_item_id = nullptr;
        const HRESULT link_result = create_links(
            nullptr,
            shortcut_path.parent_path().c_str(),
            data_object.get(),
            0,
            &created_item_id);
        std::wstring created_shortcut_path;
        HRESULT created_path_result = E_FAIL;
        const bool created_item_id_present = created_item_id != nullptr;
        if (created_item_id_present)
        {
            PWSTR created_path = nullptr;
            created_path_result = SHGetNameFromIDList(
                created_item_id,
                SIGDN_FILESYSPATH,
                &created_path);
            if (SUCCEEDED(created_path_result) && created_path)
            {
                created_shortcut_path = created_path;
            }
            CoTaskMemFree(created_path);
            CoTaskMemFree(created_item_id);
        }
        const bool created_path_available =
            SUCCEEDED(created_path_result) && !created_shortcut_path.empty();
        append_legacy_cleanup_diagnostic(
            "apps-folder-shortcut-create",
            created_path_available ? "path-resolved" : "path-resolution-unavailable",
            "SHGetNameFromIDList",
            created_path_available
                ? utf8(created_shortcut_path)
                : utf8(shortcut_path.wstring()),
            std::nullopt,
            created_path_result,
            std::string("createdItemIdPresent=") +
                (created_item_id_present ? "true" : "false") +
                "; advisoryOnly=true; exactExpectedPathVerificationRequired=true");
        append_legacy_cleanup_diagnostic(
            "apps-folder-shortcut-create",
            SUCCEEDED(link_result) ? "success" : "error",
            "SHCreateLinks",
            utf8(shortcut_path.wstring()),
            std::nullopt,
            link_result);
        if (FAILED(link_result))
        {
            set_legacy_cleanup_failure_context(
                "SHCreateLinks",
                utf8(shortcut_path.wstring()));
        }
        check_hresult(link_result);
        if (!created_shortcut_path.empty() &&
            normalize_absolute_path(created_shortcut_path) !=
            normalize_absolute_path(shortcut_path))
        {
            set_legacy_cleanup_failure_context(
                "SHCreateLinks(created-path-check)",
                utf8(created_shortcut_path));
            throw hresult_error(
                E_FAIL,
                L"Windows created the Memmy desktop shortcut at an unexpected path");
        }
        std::error_code shortcut_exists_error;
        const bool shortcut_exists = std::filesystem::exists(
            shortcut_path,
            shortcut_exists_error);
        if (shortcut_exists_error)
        {
            const DWORD error = static_cast<DWORD>(shortcut_exists_error.value());
            append_legacy_cleanup_diagnostic(
                "apps-folder-shortcut-create",
                "verify-error",
                "std::filesystem::exists",
                utf8(shortcut_path.wstring()),
                error,
                HRESULT_FROM_WIN32(error));
            set_legacy_cleanup_failure_context(
                "std::filesystem::exists",
                utf8(shortcut_path.wstring()),
                error);
            throw hresult_error(
                HRESULT_FROM_WIN32(error),
                L"Unable to inspect the expected Memmy desktop shortcut");
        }
        if (!shortcut_exists)
        {
            append_legacy_cleanup_diagnostic(
                "apps-folder-shortcut-create",
                "verify-missing",
                "std::filesystem::exists",
                utf8(shortcut_path.wstring()),
                std::nullopt,
                E_FAIL);
            throw hresult_error(E_FAIL, L"Windows did not create the expected Memmy desktop shortcut");
        }
        const DWORD shortcut_attributes = GetFileAttributesW(shortcut_path.c_str());
        if (shortcut_attributes == INVALID_FILE_ATTRIBUTES ||
            (shortcut_attributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) != 0)
        {
            const DWORD error = shortcut_attributes == INVALID_FILE_ATTRIBUTES
                ? GetLastError()
                : ERROR_INVALID_DATA;
            append_legacy_cleanup_diagnostic(
                "apps-folder-shortcut-create",
                "verify-not-regular-file",
                "GetFileAttributesW",
                utf8(shortcut_path.wstring()),
                error,
                HRESULT_FROM_WIN32(error));
            set_legacy_cleanup_failure_context(
                "GetFileAttributesW",
                utf8(shortcut_path.wstring()),
                error);
            throw hresult_error(
                HRESULT_FROM_WIN32(error),
                L"The created Memmy desktop shortcut is not a regular file");
        }
        append_legacy_cleanup_diagnostic(
            "apps-folder-shortcut-create",
            "verified-created-path",
            "std::filesystem::exists",
            utf8(shortcut_path.wstring()),
            std::nullopt,
            std::nullopt,
            "createdPath=" +
                (created_shortcut_path.empty()
                    ? std::string("<unavailable>")
                    : utf8(created_shortcut_path)) +
                "; pathResolutionHresult=" + hresult_text(created_path_result) +
                "; verifiedBy=exact-expected-path");
    }

    std::string utf8(const std::wstring& value)
    {
        return to_string(hstring(value));
    }

    std::string utc_timestamp()
    {
        SYSTEMTIME value{};
        GetSystemTime(&value);
        char buffer[32]{};
        std::snprintf(
            buffer,
            sizeof(buffer),
            "%04u-%02u-%02uT%02u:%02u:%02u.%03uZ",
            value.wYear,
            value.wMonth,
            value.wDay,
            value.wHour,
            value.wMinute,
            value.wSecond,
            value.wMilliseconds);
        return buffer;
    }

    std::string hresult_text(HRESULT value)
    {
        std::ostringstream output;
        output << "0x"
               << std::uppercase
               << std::hex
               << std::setw(8)
               << std::setfill('0')
               << static_cast<uint32_t>(value);
        return output.str();
    }

    std::optional<DWORD> win32_error_from_hresult(HRESULT value) noexcept
    {
        if (HRESULT_FACILITY(value) != FACILITY_WIN32)
        {
            return std::nullopt;
        }
        return static_cast<DWORD>(HRESULT_CODE(value));
    }

    std::string single_line(std::string value)
    {
        std::replace(value.begin(), value.end(), '\r', ' ');
        std::replace(value.begin(), value.end(), '\n', ' ');
        return value;
    }

    bool append_legacy_cleanup_diagnostic(
        const std::string& event,
        const std::string& outcome,
        const std::string& operation,
        const std::string& target,
        std::optional<DWORD> win32_error,
        std::optional<HRESULT> hresult,
        const std::string& detail) noexcept
    {
        try
        {
            if (!legacy_cleanup_diagnostics)
            {
                return false;
            }
            const auto& diagnostics = *legacy_cleanup_diagnostics;
            const DWORD log_attributes = GetFileAttributesW(diagnostics.log_path.c_str());
            if (log_attributes != INVALID_FILE_ATTRIBUTES &&
                ((log_attributes & FILE_ATTRIBUTE_DIRECTORY) != 0 ||
                    (log_attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0))
            {
                return false;
            }
            if (log_attributes == INVALID_FILE_ATTRIBUTES)
            {
                const DWORD inspect_error = GetLastError();
                if (inspect_error != ERROR_FILE_NOT_FOUND && inspect_error != ERROR_PATH_NOT_FOUND)
                {
                    return false;
                }
            }
            std::ofstream output(diagnostics.log_path, std::ios::binary | std::ios::app);
            if (!output)
            {
                return false;
            }
            output << "{\"timestamp\":\"" << utc_timestamp() << "\""
                   << ",\"processRole\":\"" << escape_json(diagnostics.process_role) << "\""
                   << ",\"transitionId\":\"" << escape_json(diagnostics.transition_id) << "\""
                   << ",\"attemptId\":\"" << escape_json(diagnostics.attempt_id) << "\""
                   << ",\"pid\":" << diagnostics.process_id;
            if (diagnostics.session_id_available)
            {
                output << ",\"sessionId\":" << diagnostics.session_id;
            }
            else
            {
                output << ",\"sessionId\":null";
            }
            output << ",\"hasPackageIdentity\":"
                   << (diagnostics.has_package_identity ? "true" : "false")
                   << ",\"packageIdentityWin32\":" << diagnostics.package_identity_result;
            if (!diagnostics.package_full_name.empty())
            {
                output << ",\"packageFullName\":\""
                       << escape_json(diagnostics.package_full_name) << "\"";
            }
            output << ",\"event\":\"" << escape_json(event) << "\"";
            if (!outcome.empty())
            {
                output << ",\"outcome\":\"" << escape_json(outcome) << "\"";
            }
            if (!operation.empty())
            {
                output << ",\"operation\":\"" << escape_json(operation) << "\"";
            }
            if (!target.empty())
            {
                output << ",\"target\":\"" << escape_json(target) << "\"";
            }
            if (win32_error)
            {
                output << ",\"win32Error\":" << *win32_error;
            }
            if (hresult)
            {
                output << ",\"hresult\":\"" << hresult_text(*hresult) << "\""
                       << ",\"hresultSigned\":" << static_cast<int32_t>(*hresult);
            }
            if (!detail.empty())
            {
                output << ",\"detail\":\"" << escape_json(single_line(detail)) << "\"";
            }
            output << "}\n";
            output.flush();
            return static_cast<bool>(output);
        }
        catch (...)
        {
            return false;
        }
    }

    void begin_legacy_cleanup_operation(
        const std::string& operation,
        const std::string& target) noexcept
    {
        if (!legacy_cleanup_diagnostics)
        {
            return;
        }
        legacy_cleanup_diagnostics->current_operation = operation;
        legacy_cleanup_diagnostics->current_target = target;
        legacy_cleanup_diagnostics->current_win32_error.reset();
        append_legacy_cleanup_diagnostic(
            operation,
            "started",
            operation,
            target);
    }

    void complete_legacy_cleanup_operation(const std::string& detail) noexcept
    {
        if (!legacy_cleanup_diagnostics)
        {
            return;
        }
        const std::string operation = legacy_cleanup_diagnostics->current_operation;
        const std::string target = legacy_cleanup_diagnostics->current_target;
        append_legacy_cleanup_diagnostic(
            operation,
            "success",
            operation,
            target,
            std::nullopt,
            std::nullopt,
            detail);
        legacy_cleanup_diagnostics->current_operation.clear();
        legacy_cleanup_diagnostics->current_target.clear();
        legacy_cleanup_diagnostics->current_win32_error.reset();
    }

    void set_legacy_cleanup_failure_context(
        const std::string& operation,
        const std::string& target,
        std::optional<DWORD> win32_error) noexcept
    {
        if (!legacy_cleanup_diagnostics)
        {
            return;
        }
        legacy_cleanup_diagnostics->current_operation = operation;
        legacy_cleanup_diagnostics->current_target = target;
        legacy_cleanup_diagnostics->current_win32_error = win32_error;
    }

    void write_text_file_atomic(
        const std::filesystem::path& target_path,
        const std::string& contents)
    {
        std::filesystem::create_directories(target_path.parent_path());
        const std::filesystem::path temporary_path =
            target_path.wstring() +
            L"." +
            std::to_wstring(GetCurrentProcessId()) +
            L".tmp";
        {
            std::ofstream output(temporary_path, std::ios::binary | std::ios::trunc);
            if (!output)
            {
                throw hresult_error(
                    HRESULT_FROM_WIN32(ERROR_WRITE_FAULT),
                    L"Unable to create the Store update handoff file");
            }
            output.write(contents.data(), static_cast<std::streamsize>(contents.size()));
            output.flush();
            if (!output)
            {
                throw hresult_error(
                    HRESULT_FROM_WIN32(ERROR_WRITE_FAULT),
                    L"Unable to write the Store update handoff file");
            }
        }
        if (!MoveFileExW(
                temporary_path.c_str(),
                target_path.c_str(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH))
        {
            const DWORD error = GetLastError();
            DeleteFileW(temporary_path.c_str());
            throw hresult_error(
                HRESULT_FROM_WIN32(error),
                L"Unable to commit the Store update handoff file");
        }
    }

    void append_handoff_log(
        const std::filesystem::path& log_path,
        const std::string& event,
        const std::string& state = "",
        const std::string& hresult = "",
        const std::string& reason = "") noexcept
    {
        try
        {
            std::filesystem::create_directories(log_path.parent_path());
            std::ofstream output(log_path, std::ios::binary | std::ios::app);
            if (!output)
            {
                return;
            }
            output << "{\"timestamp\":\"" << utc_timestamp() << "\""
                   << ",\"event\":\"" << escape_json(event) << "\"";
            if (!state.empty())
            {
                output << ",\"state\":\"" << escape_json(state) << "\"";
            }
            if (!hresult.empty())
            {
                output << ",\"hresult\":\"" << escape_json(hresult) << "\"";
            }
            if (!reason.empty())
            {
                output << ",\"reason\":\"" << escape_json(single_line(reason)) << "\"";
            }
            output << "}\n";
        }
        catch (...)
        {
        }
    }

    void write_store_install_result(
        const StoreInstallHandoffOptions& options,
        const std::string& state,
        const std::string& hresult,
        const std::string& reason)
    {
        write_text_file_atomic(
            options.result_path,
            single_line(state) + "\n" +
                single_line(hresult) + "\n" +
                single_line(reason) + "\n");
        append_handoff_log(options.log_path, "installer-result", state, hresult, reason);
    }

    void append_store_package_log(
        const std::filesystem::path& log_path,
        const std::string& event,
        const StorePackageUpdateStatus& status) noexcept
    {
        try
        {
            std::filesystem::create_directories(log_path.parent_path());
            std::ofstream output(log_path, std::ios::binary | std::ios::app);
            if (!output)
            {
                return;
            }
            output << "{\"timestamp\":\"" << utc_timestamp() << "\""
                   << ",\"event\":\"" << escape_json(event) << "\""
                   << ",\"packageFamilyName\":\""
                   << escape_json(to_string(status.PackageFamilyName)) << "\""
                   << ",\"state\":\""
                   << escape_json(update_state_name(status.PackageUpdateState)) << "\""
                   << ",\"transferredBytes\":" << status.PackageBytesDownloaded
                   << ",\"totalBytes\":" << status.PackageDownloadSizeInBytes
                   << "}\n";
        }
        catch (...)
        {
        }
    }

    StoreInstallResultFile read_store_install_result(
        const std::filesystem::path& result_path)
    {
        StoreInstallResultFile result;
        std::ifstream input(result_path, std::ios::binary);
        if (!input)
        {
            return result;
        }
        result.available = true;
        std::getline(input, result.state);
        std::getline(input, result.hresult);
        std::getline(input, result.reason);
        return result;
    }

    std::array<uint16_t, 4> parse_package_version(const std::wstring& value)
    {
        std::array<uint16_t, 4> result{};
        std::wistringstream input(value);
        std::wstring part;
        size_t index = 0;
        while (std::getline(input, part, L'.'))
        {
            if (part.empty() || index >= result.size() ||
                !std::all_of(part.begin(), part.end(), [](wchar_t character)
                {
                    return character >= L'0' && character <= L'9';
                }))
            {
                throw hresult_invalid_argument(L"Invalid Store package version");
            }
            const unsigned long parsed = std::stoul(part);
            if (parsed > UINT16_MAX)
            {
                throw hresult_invalid_argument(L"Invalid Store package version");
            }
            result[index++] = static_cast<uint16_t>(parsed);
        }
        if (index == 0)
        {
            throw hresult_invalid_argument(L"Invalid Store package version");
        }
        return result;
    }

    bool is_valid_package_family_name(const std::wstring& value)
    {
        const auto separator = value.rfind(L'_');
        if (separator == std::wstring::npos ||
            separator == 0 ||
            separator == value.size() - 1 ||
            value.size() > 161)
        {
            return false;
        }
        return std::all_of(value.begin(), value.end(), [](wchar_t character)
        {
            return character == L'.' ||
                character == L'_' ||
                character == L'-' ||
                (character >= L'0' && character <= L'9') ||
                (character >= L'A' && character <= L'Z') ||
                (character >= L'a' && character <= L'z');
        });
    }

    void ensure_plain_diagnostic_directory(
        const std::filesystem::path& directory_path,
        bool allow_create)
    {
        DWORD attributes = GetFileAttributesW(directory_path.c_str());
        if (attributes == INVALID_FILE_ATTRIBUTES && allow_create)
        {
            const DWORD inspect_error = GetLastError();
            if (inspect_error != ERROR_FILE_NOT_FOUND && inspect_error != ERROR_PATH_NOT_FOUND)
            {
                throw hresult_error(
                    HRESULT_FROM_WIN32(inspect_error),
                    L"Unable to inspect the fixed legacy cleanup diagnostic directory");
            }
            if (!CreateDirectoryW(directory_path.c_str(), nullptr))
            {
                const DWORD create_error = GetLastError();
                if (create_error != ERROR_ALREADY_EXISTS)
                {
                    throw hresult_error(
                        HRESULT_FROM_WIN32(create_error),
                        L"Unable to create the fixed legacy cleanup diagnostic directory");
                }
            }
            attributes = GetFileAttributesW(directory_path.c_str());
        }
        if (attributes == INVALID_FILE_ATTRIBUTES ||
            (attributes & FILE_ATTRIBUTE_DIRECTORY) == 0 ||
            (attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0)
        {
            throw hresult_invalid_argument(
                L"Legacy cleanup diagnostic directory is missing, not a directory, or a reparse point");
        }
    }

    std::filesystem::path resolve_legacy_cleanup_diagnostics_directory(
        const LegacyTransitionOptions& options)
    {
        if (!is_valid_package_family_name(options.package_family_name) ||
            !is_canonical_uuid(options.transition_id) ||
            !is_canonical_uuid(options.attempt_id))
        {
            throw hresult_invalid_argument(
                L"Legacy cleanup diagnostics require a valid package family and canonical IDs");
        }
        const std::filesystem::path local_app_data = resolve_known_folder_path(
            FOLDERID_LocalAppData,
            L"The current user's Local AppData directory is unavailable for legacy cleanup diagnostics");
        if (!local_app_data.is_absolute() ||
            normalize_absolute_path(local_app_data) ==
                normalize_absolute_path(local_app_data.root_path()))
        {
            throw hresult_invalid_argument(L"LOCALAPPDATA is unsafe for legacy cleanup diagnostics");
        }

        const std::filesystem::path memmy_directory = local_app_data / L"Memmy";
        if (!options.legacy_install_directory.empty() &&
            paths_overlap(options.legacy_install_directory, memmy_directory))
        {
            throw hresult_invalid_argument(
                L"Refusing to initialize Store transition diagnostics inside an overlapping legacy install path");
        }
        const std::filesystem::path diagnostics_root =
            memmy_directory / L"store-transition" / L"diagnostics";
        const std::filesystem::path transition_directory = diagnostics_root.parent_path();
        const std::filesystem::path diagnostics_directory =
            diagnostics_root /
            options.package_family_name /
            options.transition_id /
            options.attempt_id;
        if (!is_path_within_directory(diagnostics_directory, transition_directory))
        {
            throw hresult_invalid_argument(L"Legacy cleanup diagnostic path escaped its fixed root");
        }

        ensure_plain_diagnostic_directory(local_app_data, false);
        ensure_plain_diagnostic_directory(memmy_directory, true);
        ensure_plain_diagnostic_directory(transition_directory, true);
        ensure_plain_diagnostic_directory(diagnostics_root, true);
        ensure_plain_diagnostic_directory(
            diagnostics_root / options.package_family_name,
            true);
        ensure_plain_diagnostic_directory(
            diagnostics_root / options.package_family_name / options.transition_id,
            true);
        ensure_plain_diagnostic_directory(diagnostics_directory, true);
        return diagnostics_directory;
    }

    void initialize_legacy_cleanup_diagnostics(
        const LegacyTransitionOptions& options,
        const std::string& process_role)
    {
        LegacyCleanupDiagnostics diagnostics;
        diagnostics.directory_path = resolve_legacy_cleanup_diagnostics_directory(options);
        diagnostics.process_role = process_role;
        diagnostics.failure_process_role = process_role;
        diagnostics.transition_id = utf8(options.transition_id);
        diagnostics.attempt_id = utf8(options.attempt_id);
        diagnostics.process_id = GetCurrentProcessId();
        diagnostics.log_path = diagnostics.directory_path /
            (L"events-" + std::wstring(process_role.begin(), process_role.end()) +
                L"-" + std::to_wstring(diagnostics.process_id) + L".jsonl");
        diagnostics.current_operation = "diagnostic-channel-initialize";
        diagnostics.current_target = utf8(diagnostics.directory_path.wstring());
        legacy_cleanup_diagnostics = std::move(diagnostics);
        auto& active_diagnostics = *legacy_cleanup_diagnostics;

        active_diagnostics.session_id_available = ProcessIdToSessionId(
            active_diagnostics.process_id,
            &active_diagnostics.session_id) != FALSE;
        if (!active_diagnostics.session_id_available)
        {
            const DWORD error = GetLastError();
            set_legacy_cleanup_failure_context(
                "ProcessIdToSessionId",
                std::to_string(active_diagnostics.process_id),
                error);
            throw hresult_error(
                HRESULT_FROM_WIN32(error),
                L"Unable to resolve the legacy cleanup process session");
        }

        UINT32 package_name_length = 0;
        active_diagnostics.package_identity_result = GetCurrentPackageFullName(
            &package_name_length,
            nullptr);
        if (active_diagnostics.package_identity_result == ERROR_INSUFFICIENT_BUFFER &&
            package_name_length > 0)
        {
            std::vector<wchar_t> package_name(package_name_length);
            active_diagnostics.package_identity_result = GetCurrentPackageFullName(
                &package_name_length,
                package_name.data());
            if (active_diagnostics.package_identity_result != ERROR_SUCCESS)
            {
                set_legacy_cleanup_failure_context(
                    "GetCurrentPackageFullName",
                    utf8(current_executable_path().wstring()),
                    static_cast<DWORD>(active_diagnostics.package_identity_result));
                throw hresult_error(
                    HRESULT_FROM_WIN32(active_diagnostics.package_identity_result),
                    L"Unable to resolve the legacy cleanup package identity");
            }
            active_diagnostics.has_package_identity = true;
            active_diagnostics.package_full_name = utf8(std::wstring(package_name.data()));
        }
        else if (active_diagnostics.package_identity_result != APPMODEL_ERROR_NO_PACKAGE)
        {
            set_legacy_cleanup_failure_context(
                "GetCurrentPackageFullName",
                utf8(current_executable_path().wstring()),
                static_cast<DWORD>(active_diagnostics.package_identity_result));
            throw hresult_error(
                HRESULT_FROM_WIN32(active_diagnostics.package_identity_result),
                L"Unable to query the legacy cleanup package identity");
        }

        if (!append_legacy_cleanup_diagnostic(
                "process-context",
                "started",
                "query-process-context",
                utf8(current_executable_path().wstring())))
        {
            throw hresult_error(
                HRESULT_FROM_WIN32(ERROR_WRITE_FAULT),
                L"Unable to initialize the fixed legacy cleanup diagnostic log");
        }

        const std::filesystem::path process_result_path =
            legacy_cleanup_diagnostics->directory_path /
            (L"process-" + std::to_wstring(GetCurrentProcessId()) + L".result");
        write_text_file_atomic(
            process_result_path,
            "legacy-cleanup-result-v2\n" +
                single_line(legacy_cleanup_diagnostics->process_role) + "\n" +
                single_line(legacy_cleanup_diagnostics->failure_process_role) + "\n" +
                single_line(legacy_cleanup_diagnostics->transition_id) + "\n" +
                single_line(legacy_cleanup_diagnostics->attempt_id) + "\n0\n\n" +
                "diagnostic-channel-initialize\n" +
                single_line(utf8(process_result_path.wstring())) + "\nready\n");
        if (!append_legacy_cleanup_diagnostic(
                "diagnostic-channel",
                "ready",
                "write-result-channel-sentinel",
                utf8(process_result_path.wstring())))
        {
            throw hresult_error(
                HRESULT_FROM_WIN32(ERROR_WRITE_FAULT),
                L"Unable to verify the fixed legacy cleanup diagnostic log");
        }
        legacy_cleanup_diagnostics->current_operation.clear();
        legacy_cleanup_diagnostics->current_target.clear();
    }

    std::filesystem::path legacy_cleanup_process_result_path(DWORD process_id)
    {
        if (!legacy_cleanup_diagnostics)
        {
            throw hresult_error(E_UNEXPECTED, L"Legacy cleanup diagnostics are not initialized");
        }
        return legacy_cleanup_diagnostics->directory_path /
            (L"process-" + std::to_wstring(process_id) + L".result");
    }

    void write_legacy_cleanup_process_failure(
        HRESULT hresult,
        const std::string& message) noexcept
    {
        try
        {
            if (!legacy_cleanup_diagnostics)
            {
                return;
            }
            const std::optional<DWORD> win32_error =
                legacy_cleanup_diagnostics->current_win32_error
                    ? legacy_cleanup_diagnostics->current_win32_error
                    : win32_error_from_hresult(hresult);
            append_legacy_cleanup_diagnostic(
                "process-error",
                "failed",
                legacy_cleanup_diagnostics->current_operation,
                legacy_cleanup_diagnostics->current_target,
                win32_error,
                hresult,
                message);
            write_text_file_atomic(
                legacy_cleanup_process_result_path(GetCurrentProcessId()),
                "legacy-cleanup-result-v2\n" +
                    single_line(legacy_cleanup_diagnostics->process_role) + "\n" +
                    single_line(legacy_cleanup_diagnostics->failure_process_role) + "\n" +
                    single_line(legacy_cleanup_diagnostics->transition_id) + "\n" +
                    single_line(legacy_cleanup_diagnostics->attempt_id) + "\n" +
                    std::to_string(static_cast<int32_t>(hresult)) + "\n" +
                    (win32_error ? std::to_string(*win32_error) : "") + "\n" +
                    single_line(legacy_cleanup_diagnostics->current_operation) + "\n" +
                    single_line(legacy_cleanup_diagnostics->current_target) + "\n" +
                    single_line(message) + "\n");
        }
        catch (...)
        {
        }
    }

    void write_legacy_cleanup_error_to_stderr(
        HRESULT hresult,
        const std::string& message) noexcept
    {
        try
        {
            std::cerr << "{\"type\":\"error\",\"hresult\":"
                      << static_cast<int32_t>(hresult);
            if (legacy_cleanup_diagnostics)
            {
                const std::optional<DWORD> win32_error =
                    legacy_cleanup_diagnostics->current_win32_error
                        ? legacy_cleanup_diagnostics->current_win32_error
                        : win32_error_from_hresult(hresult);
                std::cerr << ",\"processRole\":\""
                          << escape_json(legacy_cleanup_diagnostics->process_role) << "\""
                          << ",\"failureProcessRole\":\""
                          << escape_json(legacy_cleanup_diagnostics->failure_process_role) << "\""
                          << ",\"transitionId\":\""
                          << escape_json(legacy_cleanup_diagnostics->transition_id) << "\""
                          << ",\"attemptId\":\""
                          << escape_json(legacy_cleanup_diagnostics->attempt_id) << "\""
                          << ",\"operation\":\""
                          << escape_json(legacy_cleanup_diagnostics->current_operation) << "\""
                          << ",\"target\":\""
                          << escape_json(legacy_cleanup_diagnostics->current_target) << "\"";
                if (win32_error)
                {
                    std::cerr << ",\"win32Error\":" << *win32_error;
                }
            }
            std::cerr << ",\"message\":\"" << escape_json(message) << "\"}\n";
            std::cerr.flush();
        }
        catch (...)
        {
        }
    }

    LegacyCleanupProcessResult read_legacy_cleanup_process_result(DWORD process_id)
    {
        LegacyCleanupProcessResult result;
        std::ifstream input(legacy_cleanup_process_result_path(process_id), std::ios::binary);
        if (!input)
        {
            return result;
        }
        std::string schema;
        std::string hresult_value;
        std::string win32_error_value;
        std::getline(input, schema);
        std::getline(input, result.process_role);
        std::getline(input, result.failure_process_role);
        std::getline(input, result.transition_id);
        std::getline(input, result.attempt_id);
        std::getline(input, hresult_value);
        std::getline(input, win32_error_value);
        std::getline(input, result.operation);
        std::getline(input, result.target);
        std::getline(input, result.message);
        if (schema != "legacy-cleanup-result-v2" ||
            result.process_role.empty() ||
            result.failure_process_role.empty() ||
            result.transition_id.empty() ||
            result.attempt_id.empty() ||
            hresult_value.empty())
        {
            return {};
        }
        try
        {
            size_t consumed = 0;
            const long long parsed = std::stoll(hresult_value, &consumed, 10);
            if (consumed != hresult_value.size() || parsed < INT32_MIN || parsed > INT32_MAX)
            {
                return {};
            }
            result.hresult = static_cast<HRESULT>(static_cast<int32_t>(parsed));
            if (!win32_error_value.empty())
            {
                size_t win32_consumed = 0;
                const unsigned long parsed_win32 = std::stoul(
                    win32_error_value,
                    &win32_consumed,
                    10);
                if (win32_consumed != win32_error_value.size())
                {
                    return {};
                }
                result.win32_error = static_cast<DWORD>(parsed_win32);
            }
            result.available = FAILED(result.hresult);
            return result;
        }
        catch (...)
        {
            return {};
        }
    }

    bool is_valid_package_full_name(const std::wstring& value)
    {
        return !value.empty() && value.size() <= PACKAGE_FULL_NAME_MAX_LENGTH &&
            std::all_of(value.begin(), value.end(), [](wchar_t character)
            {
                return character == L'.' ||
                    character == L'_' ||
                    character == L'-' ||
                    (character >= L'0' && character <= L'9') ||
                    (character >= L'A' && character <= L'Z') ||
                    (character >= L'a' && character <= L'z');
            });
    }

    DWORD parse_process_id(const std::wstring& value)
    {
        if (value.empty())
        {
            throw hresult_invalid_argument(L"--old-pid is required");
        }
        wchar_t* end = nullptr;
        const unsigned long parsed = std::wcstoul(value.c_str(), &end, 10);
        if (end == value.c_str() || *end != L'\0' || parsed == 0)
        {
            throw hresult_invalid_argument(L"--old-pid must be a non-zero process ID");
        }
        return static_cast<DWORD>(parsed);
    }

    void validate_store_install_handoff_options(
        const StoreInstallHandoffOptions& options,
        bool require_external_helper_path)
    {
        parse_package_version(options.baseline_package_version);
        if (options.created_at.empty() ||
            !is_valid_package_full_name(options.baseline_package_full_name) ||
            !is_valid_aumid(options.aumid) ||
            !is_valid_package_family_name(options.package_family_name) ||
            (options.mode != L"manual" && options.mode != L"silent") ||
            options.old_process_id == 0)
        {
            throw hresult_invalid_argument(L"Invalid Store update handoff metadata");
        }
        if (!options.state_path.is_absolute() ||
            !options.result_path.is_absolute() ||
            !options.log_path.is_absolute() ||
            options.state_path.filename() != L"store-update-install-state-v2.json" ||
            options.result_path.filename() != L"store-update-result-v1.txt" ||
            options.log_path.filename() != L"store-update-handoff.jsonl")
        {
            throw hresult_invalid_argument(L"Invalid Store update handoff paths");
        }
        const std::filesystem::path namespace_directory = options.state_path.parent_path();
        if (namespace_directory.filename() != options.package_family_name ||
            namespace_directory.parent_path().filename() != L"store-update")
        {
            throw hresult_invalid_argument(L"Store update state is outside its package family namespace");
        }
        const std::filesystem::path expected_handoff_directory =
            namespace_directory / L"handoff";
        if (normalize_absolute_path(options.result_path.parent_path()) !=
                normalize_absolute_path(expected_handoff_directory) ||
            normalize_absolute_path(options.log_path.parent_path()) !=
                normalize_absolute_path(expected_handoff_directory))
        {
            throw hresult_invalid_argument(L"Store update handoff paths do not share the expected directory");
        }
        if (require_external_helper_path)
        {
            const std::filesystem::path expected_external_helper =
                resolve_environment_path(
                    L"LOCALAPPDATA",
                    L"LOCALAPPDATA is unavailable for Store update finalization") /
                L"Memmy" /
                L"store-update" /
                options.package_family_name /
                L"MemmyStoreUpdate.exe";
            if (!options.external_helper_path.is_absolute() ||
                normalize_absolute_path(options.external_helper_path) !=
                    normalize_absolute_path(expected_external_helper) ||
                is_windows_apps_path(options.external_helper_path) ||
                !std::filesystem::is_regular_file(options.external_helper_path))
            {
                throw hresult_invalid_argument(L"Invalid external Store update helper path");
            }
        }
    }

    std::vector<std::wstring> registered_package_full_names(
        const std::wstring& package_family_name)
    {
        if (package_family_name.empty())
        {
            throw hresult_invalid_argument(L"Package family name is required");
        }

        UINT32 count = 0;
        UINT32 buffer_length = 0;
        LONG result = GetPackagesByPackageFamily(
            package_family_name.c_str(),
            &count,
            nullptr,
            &buffer_length,
            nullptr);
        if (result == ERROR_SUCCESS)
        {
            if (count != 0)
            {
                throw hresult_error(
                    E_UNEXPECTED,
                    L"Package registration query returned names without a buffer");
            }
            return {};
        }
        if (result != ERROR_INSUFFICIENT_BUFFER)
        {
            throw hresult_error(
                HRESULT_FROM_WIN32(result),
                L"Unable to query package-family registration");
        }

        for (unsigned int attempt = 0; attempt < 4; ++attempt)
        {
            if (count == 0 || buffer_length == 0)
            {
                throw hresult_error(
                    E_UNEXPECTED,
                    L"Package registration query returned an invalid buffer size");
            }

            std::vector<wchar_t*> package_full_names(count);
            std::vector<wchar_t> package_full_name_buffer(buffer_length);
            UINT32 read_count = count;
            UINT32 read_buffer_length = buffer_length;
            result = GetPackagesByPackageFamily(
                package_family_name.c_str(),
                &read_count,
                package_full_names.data(),
                &read_buffer_length,
                package_full_name_buffer.data());
            if (result == ERROR_INSUFFICIENT_BUFFER)
            {
                count = read_count;
                buffer_length = read_buffer_length;
                continue;
            }
            if (result != ERROR_SUCCESS)
            {
                throw hresult_error(
                    HRESULT_FROM_WIN32(result),
                    L"Unable to read package-family registration");
            }

            std::vector<std::wstring> result_full_names;
            result_full_names.reserve(read_count);
            for (UINT32 index = 0; index < read_count; ++index)
            {
                if (index >= package_full_names.size() ||
                    package_full_names[index] == nullptr ||
                    package_full_names[index][0] == L'\0')
                {
                    throw hresult_error(
                        E_UNEXPECTED,
                        L"Package registration query returned an invalid package full name");
                }
                result_full_names.emplace_back(package_full_names[index]);
            }
            return result_full_names;
        }

        throw hresult_error(
            HRESULT_FROM_WIN32(ERROR_INSUFFICIENT_BUFFER),
            L"Package-family registration changed during the query");
    }

    void emit_package_family_registration(const std::wstring& package_family_name)
    {
        const auto package_full_names =
            registered_package_full_names(package_family_name);
        std::ostringstream output;
        output << "{\"type\":\"package-family-registration\""
               << ",\"packageFamilyName\":\""
               << escape_json(utf8(package_family_name)) << "\""
               << ",\"registered\":"
               << (package_full_names.empty() ? "false" : "true")
               << ",\"packageFullNames\":[";
        for (size_t index = 0; index < package_full_names.size(); ++index)
        {
            if (index != 0)
            {
                output << ',';
            }
            output << '\"' << escape_json(utf8(package_full_names[index])) << '\"';
        }
        output << "]}";
        write_json_line(output.str());
    }

    struct InstalledPackageIdentity
    {
        std::wstring full_name;
        std::array<uint16_t, 4> version;
    };

    std::optional<InstalledPackageIdentity> installed_package_identity(
        const std::wstring& package_family_name)
    {
        UINT32 count = 0;
        UINT32 buffer_length = 0;
        LONG result = GetPackagesByPackageFamily(
            package_family_name.c_str(),
            &count,
            nullptr,
            &buffer_length,
            nullptr);
        if (result == ERROR_SUCCESS && count == 0)
        {
            return std::nullopt;
        }
        if (result != ERROR_INSUFFICIENT_BUFFER)
        {
            throw hresult_error(
                HRESULT_FROM_WIN32(result),
                L"Unable to query the installed Store package");
        }

        std::vector<wchar_t*> package_full_names(count);
        std::vector<wchar_t> package_full_name_buffer(buffer_length);
        result = GetPackagesByPackageFamily(
            package_family_name.c_str(),
            &count,
            package_full_names.data(),
            &buffer_length,
            package_full_name_buffer.data());
        if (result != ERROR_SUCCESS)
        {
            throw hresult_error(
                HRESULT_FROM_WIN32(result),
                L"Unable to read the installed Store package");
        }

        std::optional<InstalledPackageIdentity> latest;
        for (UINT32 index = 0; index < count; ++index)
        {
            UINT32 package_id_length = 0;
            LONG id_result = PackageIdFromFullName(
                package_full_names[index],
                PACKAGE_INFORMATION_BASIC,
                &package_id_length,
                nullptr);
            if (id_result != ERROR_INSUFFICIENT_BUFFER)
            {
                continue;
            }
            std::vector<unsigned char> package_id_storage(package_id_length);
            auto* package_id = reinterpret_cast<PACKAGE_ID*>(package_id_storage.data());
            id_result = PackageIdFromFullName(
                package_full_names[index],
                PACKAGE_INFORMATION_BASIC,
                &package_id_length,
                reinterpret_cast<BYTE*>(package_id));
            if (id_result != ERROR_SUCCESS)
            {
                continue;
            }
            const std::array<uint16_t, 4> version{
                package_id->version.Major,
                package_id->version.Minor,
                package_id->version.Build,
                package_id->version.Revision
            };
            if (!latest || version > latest->version)
            {
                latest = InstalledPackageIdentity{package_full_names[index], version};
            }
        }
        return latest;
    }

    bool installed_package_replaced_baseline(const StoreInstallHandoffOptions& options)
    {
        const auto installed = installed_package_identity(options.package_family_name);
        if (!installed)
        {
            return false;
        }
        const auto baseline_version = parse_package_version(options.baseline_package_version);
        return installed->version > baseline_version ||
            (installed->version == baseline_version &&
             installed->full_name != options.baseline_package_full_name);
    }

    void write_failed_store_install_state(
        const StoreInstallHandoffOptions& options,
        const std::string& native_state,
        const std::string& hresult,
        const std::string& reason)
    {
        const std::string created_at = escape_json(utf8(options.created_at));
        const std::string timestamp = utc_timestamp();
        const bool manual = options.mode == L"manual";
        std::ostringstream output;
        output << "{\n"
               << "  \"schemaVersion\": 2,\n"
               << "  \"mode\": \"" << (manual ? "manual" : "silent") << "\",\n"
               << "  \"status\": \"failed\",\n"
               << "  \"baselinePackageVersion\": \""
               << escape_json(utf8(options.baseline_package_version)) << "\",\n"
               << "  \"baselinePackageFullName\": \""
               << escape_json(utf8(options.baseline_package_full_name)) << "\",\n"
               << "  \"oldPid\": " << options.old_process_id << ",\n"
               << "  \"createdAt\": \"" << created_at << "\",\n"
               << "  \"updatedAt\": \"" << timestamp << "\",\n"
               << "  \"autoActivateOnSuccess\": " << (manual ? "true" : "false") << ",\n"
               << "  \"aumid\": \"" << escape_json(utf8(options.aumid)) << "\",\n"
               << "  \"packageFamilyName\": \"" << escape_json(utf8(options.package_family_name)) << "\",\n"
               << "  \"nativeState\": \"" << escape_json(native_state) << "\",\n"
               << "  \"hresult\": "
               << (hresult.empty() ? "null" : "\"" + escape_json(hresult) + "\"") << ",\n"
               << "  \"failureReason\": \"" << escape_json(single_line(reason)) << "\",\n"
               << "  \"failurePending\": true\n"
               << "}\n";
        write_text_file_atomic(options.state_path, output.str());
    }

    void activate_store_application(const std::wstring& aumid)
    {
        com_ptr<IApplicationActivationManager> activation_manager;
        check_hresult(CoCreateInstance(
            CLSID_ApplicationActivationManager,
            nullptr,
            CLSCTX_INPROC_SERVER,
            IID_PPV_ARGS(activation_manager.put())));
        DWORD process_id = 0;
        check_hresult(activation_manager->ActivateApplication(
            aumid.c_str(),
            nullptr,
            AO_NONE,
            &process_id));
    }

    bool activate_store_application_with_retry(
        const StoreInstallHandoffOptions& options,
        const std::string& state) noexcept
    {
        for (int attempt = 1; attempt <= 10; ++attempt)
        {
            try
            {
                activate_store_application(options.aumid);
                append_handoff_log(options.log_path, "application-activated", state);
                return true;
            }
            catch (const hresult_error& error)
            {
                append_handoff_log(
                    options.log_path,
                    "application-activation-retry",
                    state,
                    hresult_text(error.code()),
                    to_string(error.message()));
            }
            std::this_thread::sleep_for(std::chrono::seconds(2));
        }
        append_handoff_log(
            options.log_path,
            "application-activation-failed",
            state,
            "",
            "AUMID activation did not succeed after 10 attempts");
        return false;
    }

    std::vector<std::wstring> build_store_finalizer_arguments(
        const std::filesystem::path& executable_path,
        const std::wstring& command,
        const StoreInstallHandoffOptions& options,
        bool include_external_helper_path)
    {
        std::vector<std::wstring> arguments{
            executable_path.wstring(),
            command,
            L"--state-path", options.state_path.wstring(),
            L"--result-path", options.result_path.wstring(),
            L"--log-path", options.log_path.wstring(),
            L"--old-pid", std::to_wstring(options.old_process_id),
            L"--baseline-package-version", options.baseline_package_version,
            L"--baseline-package-full-name", options.baseline_package_full_name,
            L"--created-at", options.created_at,
            L"--aumid", options.aumid,
            L"--package-family-name", options.package_family_name,
            L"--mode", options.mode
        };
        if (include_external_helper_path)
        {
            arguments.insert(arguments.end(), {
                L"--external-helper-path",
                options.external_helper_path.wstring()
            });
        }
        return arguments;
    }

    void launch_detached_process(
        const std::filesystem::path& executable_path,
        const std::vector<std::wstring>& arguments,
        bool set_breakaway_policy)
    {
        std::wstring command_line;
        for (const auto& argument : arguments)
        {
            if (!command_line.empty())
            {
                command_line.push_back(L' ');
            }
            command_line.append(quote_command_line_argument(argument));
        }

        STARTUPINFOEXW startup{};
        startup.StartupInfo.cb = sizeof(startup);
        std::vector<unsigned char> attribute_storage;
        if (set_breakaway_policy)
        {
            SIZE_T attribute_list_size = 0;
            InitializeProcThreadAttributeList(nullptr, 1, 0, &attribute_list_size);
            attribute_storage.resize(attribute_list_size);
            startup.lpAttributeList = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(
                attribute_storage.data());
            if (!InitializeProcThreadAttributeList(
                    startup.lpAttributeList,
                    1,
                    0,
                    &attribute_list_size))
            {
                throw hresult_error(
                    HRESULT_FROM_WIN32(GetLastError()),
                    L"Unable to initialize the Store update finalizer policy");
            }
            DWORD desktop_app_policy =
                PROCESS_CREATION_DESKTOP_APP_BREAKAWAY_ENABLE_PROCESS_TREE |
                PROCESS_CREATION_DESKTOP_APP_BREAKAWAY_OVERRIDE;
            if (!UpdateProcThreadAttribute(
                    startup.lpAttributeList,
                    0,
                    PROC_THREAD_ATTRIBUTE_DESKTOP_APP_POLICY,
                    &desktop_app_policy,
                    sizeof(desktop_app_policy),
                    nullptr,
                    nullptr))
            {
                const DWORD error = GetLastError();
                DeleteProcThreadAttributeList(startup.lpAttributeList);
                throw hresult_error(
                    HRESULT_FROM_WIN32(error),
                    L"Unable to set the Store update finalizer breakaway policy");
            }
        }

        PROCESS_INFORMATION process{};
        const DWORD creation_flags = CREATE_NO_WINDOW | DETACHED_PROCESS |
            (set_breakaway_policy ? EXTENDED_STARTUPINFO_PRESENT : 0);
        const BOOL created = CreateProcessW(
            executable_path.c_str(),
            command_line.data(),
            nullptr,
            nullptr,
            FALSE,
            creation_flags,
            nullptr,
            executable_path.parent_path().c_str(),
            &startup.StartupInfo,
            &process);
        const DWORD create_error = created ? ERROR_SUCCESS : GetLastError();
        if (startup.lpAttributeList != nullptr)
        {
            DeleteProcThreadAttributeList(startup.lpAttributeList);
        }
        if (!created)
        {
            throw hresult_error(
                HRESULT_FROM_WIN32(create_error),
                L"Unable to start the Store update finalizer process");
        }
        CloseHandle(process.hThread);
        CloseHandle(process.hProcess);
    }

    void validate_legacy_transition_options(
        const LegacyTransitionOptions& options,
        bool require_identity,
        bool require_external_helper)
    {
        if (options.legacy_install_directory.empty() ||
            options.legacy_executable_path.empty())
        {
            throw hresult_invalid_argument(
                L"Legacy takeover requires --legacy-install-directory and --legacy-executable-path");
        }
        if (require_identity &&
            (!is_valid_aumid(options.aumid) ||
             !is_valid_package_family_name(options.package_family_name) ||
             options.aumid != options.package_family_name + L"!Memmy" ||
             !is_canonical_uuid(options.transition_id) ||
             !is_canonical_uuid(options.attempt_id)))
        {
            throw hresult_invalid_argument(
                L"Legacy cleanup Store identity or diagnostic IDs are invalid");
        }
        if (!options.shortcut_path.empty())
        {
            const std::filesystem::path expected_desktop_shortcut =
                resolve_known_folder_path(
                    FOLDERID_Desktop,
                    L"The current user's Desktop directory is unavailable for legacy cleanup") /
                L"Memmy.lnk";
            if (!options.shortcut_path.is_absolute() ||
                normalize_absolute_path(options.shortcut_path) !=
                    normalize_absolute_path(expected_desktop_shortcut))
            {
                throw hresult_invalid_argument(
                    L"--shortcut must be the current user's fixed Desktop Memmy.lnk path");
            }
        }
        if (require_external_helper)
        {
            const std::filesystem::path expected_helper =
                resolve_known_folder_path(
                    FOLDERID_LocalAppData,
                    L"The current user's Local AppData directory is unavailable for legacy cleanup") /
                L"Memmy" /
                L"store-transition" /
                L"native" /
                options.package_family_name /
                L"MemmyStoreUpdate.exe";
            std::error_code file_error;
            if (!options.external_helper_path.is_absolute() ||
                normalize_absolute_path(options.external_helper_path) !=
                    normalize_absolute_path(expected_helper) ||
                is_windows_apps_path(options.external_helper_path) ||
                !std::filesystem::is_regular_file(options.external_helper_path, file_error) ||
                file_error)
            {
                throw hresult_invalid_argument(
                    L"Refusing to use an unexpected unpackaged legacy cleanup helper");
            }
        }
    }

    std::vector<std::wstring> build_legacy_cleanup_arguments(
        const std::filesystem::path& executable_path,
        const std::wstring& command,
        const LegacyTransitionOptions& options,
        bool include_external_helper)
    {
        std::vector<std::wstring> arguments{
            executable_path.wstring(),
            command,
            L"--legacy-install-directory", options.legacy_install_directory.wstring(),
            L"--legacy-executable-path", options.legacy_executable_path.wstring(),
            L"--aumid", options.aumid,
            L"--package-family-name", options.package_family_name,
            L"--transition-id", options.transition_id,
            L"--attempt-id", options.attempt_id
        };
        if (include_external_helper)
        {
            arguments.insert(arguments.end(), {
                L"--external-helper-path",
                options.external_helper_path.wstring()
            });
        }
        if (!options.shortcut_path.empty())
        {
            arguments.insert(arguments.end(), {
                L"--shortcut",
                options.shortcut_path.wstring()
            });
        }
        return arguments;
    }

    std::string legacy_cleanup_process_role_for_command(const std::wstring& command)
    {
        if (command == L"finalize-legacy-cleanup-breakaway-launcher")
        {
            return "breakaway-launcher";
        }
        if (command == L"finalize-legacy-cleanup-unpackaged")
        {
            return "external-unpackaged-helper";
        }
        return "unknown-child";
    }

    void run_legacy_cleanup_process(
        const std::filesystem::path& executable_path,
        const std::vector<std::wstring>& arguments,
        bool set_breakaway_policy)
    {
        if (arguments.size() < 2)
        {
            throw hresult_invalid_argument(L"Legacy cleanup child command is missing");
        }
        const std::string expected_child_role =
            legacy_cleanup_process_role_for_command(arguments[1]);
        std::wstring command_line;
        for (const auto& argument : arguments)
        {
            if (!command_line.empty())
            {
                command_line.push_back(L' ');
            }
            command_line.append(quote_command_line_argument(argument));
        }
        STARTUPINFOEXW startup{};
        startup.StartupInfo.cb = sizeof(startup);
        std::vector<unsigned char> attribute_storage;
        if (set_breakaway_policy)
        {
            SIZE_T attribute_list_size = 0;
            InitializeProcThreadAttributeList(nullptr, 1, 0, &attribute_list_size);
            attribute_storage.resize(attribute_list_size);
            startup.lpAttributeList = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(
                attribute_storage.data());
            if (!InitializeProcThreadAttributeList(
                    startup.lpAttributeList,
                    1,
                    0,
                    &attribute_list_size))
            {
                throw hresult_error(
                    HRESULT_FROM_WIN32(GetLastError()),
                    L"Unable to initialize the legacy cleanup breakaway policy");
            }
            DWORD desktop_app_policy =
                PROCESS_CREATION_DESKTOP_APP_BREAKAWAY_ENABLE_PROCESS_TREE |
                PROCESS_CREATION_DESKTOP_APP_BREAKAWAY_OVERRIDE;
            if (!UpdateProcThreadAttribute(
                    startup.lpAttributeList,
                    0,
                    PROC_THREAD_ATTRIBUTE_DESKTOP_APP_POLICY,
                    &desktop_app_policy,
                    sizeof(desktop_app_policy),
                    nullptr,
                    nullptr))
            {
                const DWORD error = GetLastError();
                DeleteProcThreadAttributeList(startup.lpAttributeList);
                throw hresult_error(
                    HRESULT_FROM_WIN32(error),
                    L"Unable to set the legacy cleanup breakaway policy");
            }
        }
        PROCESS_INFORMATION process{};
        const DWORD creation_flags = CREATE_NO_WINDOW |
            (set_breakaway_policy ? EXTENDED_STARTUPINFO_PRESENT : 0);
        const BOOL created = CreateProcessW(
            executable_path.c_str(),
            command_line.data(),
            nullptr,
            nullptr,
            FALSE,
            creation_flags,
            nullptr,
            executable_path.parent_path().c_str(),
            &startup.StartupInfo,
            &process);
        const DWORD create_error = created ? ERROR_SUCCESS : GetLastError();
        if (startup.lpAttributeList != nullptr)
        {
            DeleteProcThreadAttributeList(startup.lpAttributeList);
        }
        if (!created)
        {
            append_legacy_cleanup_diagnostic(
                "child-process-create",
                "error",
                expected_child_role,
                utf8(executable_path.wstring()),
                create_error,
                HRESULT_FROM_WIN32(create_error));
            throw hresult_error(
                HRESULT_FROM_WIN32(create_error),
                L"Unable to start unpackaged legacy cleanup");
        }
        const DWORD child_process_id = process.dwProcessId;
        append_legacy_cleanup_diagnostic(
            "child-process-create",
            "success",
            expected_child_role,
            utf8(executable_path.wstring()),
            ERROR_SUCCESS,
            S_OK,
            "childPid=" + std::to_string(child_process_id));
        CloseHandle(process.hThread);
        const DWORD wait_timeout_milliseconds = set_breakaway_policy ? 150000 : 120000;
        const DWORD wait_result = WaitForSingleObject(
            process.hProcess,
            wait_timeout_milliseconds);
        if (wait_result == WAIT_TIMEOUT)
        {
            const BOOL terminated = TerminateProcess(process.hProcess, ERROR_TIMEOUT);
            const DWORD terminate_error = terminated ? ERROR_SUCCESS : GetLastError();
            const DWORD termination_wait_result = WaitForSingleObject(process.hProcess, 5000);
            CloseHandle(process.hProcess);
            append_legacy_cleanup_diagnostic(
                "child-process-result",
                "timeout",
                expected_child_role,
                utf8(executable_path.wstring()),
                ERROR_TIMEOUT,
                HRESULT_FROM_WIN32(ERROR_TIMEOUT),
                "childPid=" + std::to_string(child_process_id) +
                    "; waitTimeoutMilliseconds=" + std::to_string(wait_timeout_milliseconds) +
                    "; terminateProcess=" + (terminated ? "success" : "failed") +
                    "; terminateWin32=" + std::to_string(terminate_error) +
                    "; terminationWaitResult=" + std::to_string(termination_wait_result));
            throw hresult_error(
                HRESULT_FROM_WIN32(ERROR_TIMEOUT),
                L"Unpackaged legacy cleanup timed out");
        }
        if (wait_result != WAIT_OBJECT_0)
        {
            const DWORD wait_error = GetLastError();
            CloseHandle(process.hProcess);
            append_legacy_cleanup_diagnostic(
                "child-process-result",
                "wait-error",
                expected_child_role,
                utf8(executable_path.wstring()),
                wait_error,
                HRESULT_FROM_WIN32(wait_error),
                "childPid=" + std::to_string(child_process_id));
            throw hresult_error(
                HRESULT_FROM_WIN32(wait_error),
                L"Unable to wait for unpackaged legacy cleanup");
        }
        DWORD exit_code = ERROR_GEN_FAILURE;
        const BOOL read_exit_code = GetExitCodeProcess(process.hProcess, &exit_code);
        const DWORD exit_error = read_exit_code ? ERROR_SUCCESS : GetLastError();
        CloseHandle(process.hProcess);
        if (!read_exit_code)
        {
            append_legacy_cleanup_diagnostic(
                "child-process-result",
                "exit-code-error",
                expected_child_role,
                utf8(executable_path.wstring()),
                exit_error,
                HRESULT_FROM_WIN32(exit_error),
                "childPid=" + std::to_string(child_process_id));
            throw hresult_error(
                HRESULT_FROM_WIN32(exit_error),
                L"Unable to read the unpackaged legacy cleanup result");
        }
        const LegacyCleanupProcessResult child_result =
            read_legacy_cleanup_process_result(child_process_id);
        const bool child_result_matches_context =
            child_result.available &&
            child_result.process_role == expected_child_role &&
            legacy_cleanup_diagnostics &&
            child_result.transition_id == legacy_cleanup_diagnostics->transition_id &&
            child_result.attempt_id == legacy_cleanup_diagnostics->attempt_id;
        append_legacy_cleanup_diagnostic(
            "child-process-result",
            exit_code == 0
                ? "success"
                : (child_result_matches_context ? "failure-preserved" : "failure-result-invalid"),
            child_result_matches_context ? child_result.operation : expected_child_role,
            child_result_matches_context ? child_result.target : utf8(executable_path.wstring()),
            child_result_matches_context ? child_result.win32_error : std::nullopt,
            child_result.available ? std::optional<HRESULT>(child_result.hresult) : std::nullopt,
            "childPid=" + std::to_string(child_process_id) +
                "; childExitCode=" + std::to_string(exit_code) +
                (child_result.available
                    ? "; childProcessRole=" + child_result.process_role +
                        "; failureProcessRole=" + child_result.failure_process_role +
                        "; childTransitionId=" + child_result.transition_id +
                        "; childAttemptId=" + child_result.attempt_id +
                        "; childOperation=" + child_result.operation +
                        "; childTarget=" + child_result.target +
                        "; childMessage=" + child_result.message
                    : ""));
        if (exit_code != 0)
        {
            if (child_result_matches_context)
            {
                legacy_cleanup_diagnostics->failure_process_role =
                    child_result.failure_process_role;
                legacy_cleanup_diagnostics->current_operation = child_result.operation;
                legacy_cleanup_diagnostics->current_target = child_result.target;
                legacy_cleanup_diagnostics->current_win32_error = child_result.win32_error;
                throw hresult_error(
                    child_result.hresult,
                    to_hstring(
                        "Legacy cleanup child failed; failureProcessRole=" +
                        child_result.failure_process_role +
                        "; childPid=" + std::to_string(child_process_id) +
                        "; operation=" + child_result.operation +
                        "; target=" + child_result.target +
                        (child_result.win32_error
                            ? "; win32Error=" + std::to_string(*child_result.win32_error)
                            : "") +
                        "; message=" + child_result.message));
            }
            const HRESULT child_exit_hresult = static_cast<HRESULT>(exit_code);
            if (FAILED(child_exit_hresult))
            {
                legacy_cleanup_diagnostics->failure_process_role = expected_child_role;
                set_legacy_cleanup_failure_context(
                    "child-result-channel",
                    utf8(executable_path.wstring()),
                    win32_error_from_hresult(child_exit_hresult));
                throw hresult_error(
                    child_exit_hresult,
                    to_hstring(
                        "Legacy cleanup child failed before it could publish a valid result; "
                        "failureProcessRole=" + expected_child_role +
                        "; childPid=" + std::to_string(child_process_id) +
                        "; childExitHresult=" + hresult_text(child_exit_hresult)));
            }
            throw hresult_error(
                E_FAIL,
                to_hstring(
                    "Legacy cleanup child failed without a valid result; expectedProcessRole=" +
                    expected_child_role + "; childPid=" + std::to_string(child_process_id) +
                    "; childExitCode=" + std::to_string(exit_code)));
        }
    }

    void finalize_legacy_cleanup_unpacked(const LegacyTransitionOptions& options)
    {
        begin_legacy_cleanup_operation(
            "identity-query",
            utf8(current_executable_path().wstring()));
        if (current_process_has_package_identity())
        {
            throw hresult_error(
                E_ACCESSDENIED,
                L"Refusing to mutate the real legacy installation from a packaged process");
        }
        complete_legacy_cleanup_operation("requiredPackageIdentity=false");

        begin_legacy_cleanup_operation(
            "authority-registry",
            registry_target(legacy_installer_key, L"InstallLocation"));
        const bool install_exists = validate_legacy_install_authority(
            options.legacy_install_directory,
            options.legacy_executable_path);
        complete_legacy_cleanup_operation(
            std::string("installExists=") + (install_exists ? "true" : "false"));
        if (install_exists)
        {
            begin_legacy_cleanup_operation(
                "legacy-processes-stop",
                utf8(options.legacy_install_directory.wstring()));
            prepare_legacy_takeover(options);
            complete_legacy_cleanup_operation();

            begin_legacy_cleanup_operation(
                "install-directory-delete",
                utf8(options.legacy_install_directory.wstring()));
            remove_legacy_install_directory(options);
            complete_legacy_cleanup_operation();
        }
        else
        {
            append_legacy_cleanup_diagnostic(
                "legacy-processes-stop",
                "skipped-install-missing",
                "prepare-legacy-takeover",
                utf8(options.legacy_install_directory.wstring()));
            append_legacy_cleanup_diagnostic(
                "install-directory-delete",
                "skipped-install-missing",
                "delete-directory-tree",
                utf8(options.legacy_install_directory.wstring()));
        }
        begin_legacy_cleanup_operation(
            "install-directory-post-check",
            utf8(options.legacy_install_directory.wstring()));
        const bool install_directory_missing = path_is_missing(
            options.legacy_install_directory);
        if (!install_directory_missing)
        {
            throw hresult_error(
                E_FAIL,
                L"Legacy Memmy install directory is still present after cleanup");
        }
        complete_legacy_cleanup_operation("missing=true");

        begin_legacy_cleanup_operation(
            "uninstall-registry-delete",
            registry_target(legacy_uninstall_key));
        delete_registry_tree_if_present(
            legacy_uninstall_key,
            KEY_WOW64_32KEY,
            "32-bit");
        delete_registry_tree_if_present(
            legacy_uninstall_key,
            KEY_WOW64_64KEY,
            "64-bit");
        complete_legacy_cleanup_operation();

        begin_legacy_cleanup_operation(
            "installer-authority-registry-delete",
            registry_target(legacy_installer_key));
        delete_registry_tree_if_present(
            legacy_installer_key,
            KEY_WOW64_32KEY,
            "32-bit");
        delete_registry_tree_if_present(
            legacy_installer_key,
            KEY_WOW64_64KEY,
            "64-bit");
        complete_legacy_cleanup_operation();

        begin_legacy_cleanup_operation(
            "uninstall-registry-delete",
            registry_target(legacy_uninstall_key));
        const bool uninstall_registry_32_exists = registry_tree_exists(
            legacy_uninstall_key,
            KEY_WOW64_32KEY,
            "32-bit");
        const bool uninstall_registry_64_exists = registry_tree_exists(
            legacy_uninstall_key,
            KEY_WOW64_64KEY,
            "64-bit");
        complete_legacy_cleanup_operation(
            "32BitExists=" + std::string(uninstall_registry_32_exists ? "true" : "false") +
            "; 64BitExists=" + std::string(uninstall_registry_64_exists ? "true" : "false"));

        begin_legacy_cleanup_operation(
            "installer-authority-registry-delete",
            registry_target(legacy_installer_key));
        const bool installer_registry_32_exists = registry_tree_exists(
            legacy_installer_key,
            KEY_WOW64_32KEY,
            "32-bit");
        const bool installer_registry_64_exists = registry_tree_exists(
            legacy_installer_key,
            KEY_WOW64_64KEY,
            "64-bit");
        complete_legacy_cleanup_operation(
            "32BitExists=" + std::string(installer_registry_32_exists ? "true" : "false") +
            "; 64BitExists=" + std::string(installer_registry_64_exists ? "true" : "false"));
        if (uninstall_registry_32_exists ||
            uninstall_registry_64_exists ||
            installer_registry_32_exists ||
            installer_registry_64_exists)
        {
            const bool uninstall_key_remains =
                uninstall_registry_32_exists || uninstall_registry_64_exists;
            const bool remaining_in_32_bit_view = uninstall_key_remains
                ? uninstall_registry_32_exists
                : installer_registry_32_exists;
            set_legacy_cleanup_failure_context(
                "RegOpenKeyExW(post-check)",
                registry_target(
                    uninstall_key_remains ? legacy_uninstall_key : legacy_installer_key) +
                    "; view=" + (remaining_in_32_bit_view ? "32-bit" : "64-bit"));
            throw hresult_error(
                E_FAIL,
                L"Legacy uninstall registration is still present after cleanup");
        }
        constexpr wchar_t run_key[] = L"Software\\Microsoft\\Windows\\CurrentVersion\\Run";

        begin_legacy_cleanup_operation(
            "run-registry-delete",
            registry_target(run_key));
        delete_registry_value_if_present(run_key, legacy_app_user_model_id);
        delete_registry_value_if_present(run_key, L"Memmy");
        delete_registry_value_if_present(run_key, L"memmy");
        complete_legacy_cleanup_operation();

        begin_legacy_cleanup_operation(
            "user-path-update",
            "HKCU\\Environment\\Path");
        remove_legacy_cli_from_user_path(options.legacy_install_directory);
        complete_legacy_cleanup_operation();

        const std::filesystem::path start_menu_shortcut = resolve_known_folder_path(
            FOLDERID_Programs,
            L"The current user's Start Menu Programs directory is unavailable for legacy cleanup") /
            L"Memmy.lnk";
        begin_legacy_cleanup_operation(
            "start-menu-shortcut-delete",
            utf8(start_menu_shortcut.wstring()));
        const BOOL start_menu_deleted = DeleteFileW(start_menu_shortcut.c_str());
        const DWORD start_menu_error = start_menu_deleted ? ERROR_SUCCESS : GetLastError();
        append_legacy_cleanup_diagnostic(
            "start-menu-shortcut-delete",
            start_menu_deleted
                ? "success"
                : (start_menu_error == ERROR_FILE_NOT_FOUND || start_menu_error == ERROR_PATH_NOT_FOUND
                    ? "already-missing"
                    : "error"),
            "DeleteFileW",
            utf8(start_menu_shortcut.wstring()),
            start_menu_error,
            HRESULT_FROM_WIN32(start_menu_error));
        if (!start_menu_deleted &&
            start_menu_error != ERROR_FILE_NOT_FOUND &&
            start_menu_error != ERROR_PATH_NOT_FOUND)
        {
            set_legacy_cleanup_failure_context(
                "DeleteFileW",
                utf8(start_menu_shortcut.wstring()),
                start_menu_error);
            throw hresult_error(
                HRESULT_FROM_WIN32(start_menu_error),
                L"Unable to delete the legacy Memmy Start Menu shortcut");
        }
        const DWORD start_menu_attributes = GetFileAttributesW(start_menu_shortcut.c_str());
        if (start_menu_attributes != INVALID_FILE_ATTRIBUTES)
        {
            set_legacy_cleanup_failure_context(
                "GetFileAttributesW(post-check)",
                utf8(start_menu_shortcut.wstring()));
            throw hresult_error(
                E_FAIL,
                L"The legacy Memmy Start Menu shortcut is still present after cleanup");
        }
        const DWORD start_menu_post_check_error = GetLastError();
        append_legacy_cleanup_diagnostic(
            "start-menu-shortcut-delete",
            start_menu_post_check_error == ERROR_FILE_NOT_FOUND ||
                    start_menu_post_check_error == ERROR_PATH_NOT_FOUND
                ? "verified-missing"
                : "verify-error",
            "GetFileAttributesW(post-check)",
            utf8(start_menu_shortcut.wstring()),
            start_menu_post_check_error,
            HRESULT_FROM_WIN32(start_menu_post_check_error));
        if (start_menu_post_check_error != ERROR_FILE_NOT_FOUND &&
            start_menu_post_check_error != ERROR_PATH_NOT_FOUND)
        {
            set_legacy_cleanup_failure_context(
                "GetFileAttributesW(post-check)",
                utf8(start_menu_shortcut.wstring()),
                start_menu_post_check_error);
            throw hresult_error(
                HRESULT_FROM_WIN32(start_menu_post_check_error),
                L"Unable to verify removal of the legacy Memmy Start Menu shortcut");
        }
        complete_legacy_cleanup_operation(
            "deleteResult=" + std::to_string(start_menu_error) +
            "; postCheck=" + std::to_string(start_menu_post_check_error));

        const std::filesystem::path local_app_data = resolve_known_folder_path(
            FOLDERID_LocalAppData,
            L"The current user's Local AppData directory is unavailable for legacy cleanup");
        const std::filesystem::path launcher_directory =
            local_app_data / L"Memmy" / L"launcher";
        begin_legacy_cleanup_operation(
            "launcher-directory-delete",
            utf8(launcher_directory.wstring()));
        const DeleteTreeResult launcher_result = delete_directory_tree_once(launcher_directory);
        append_legacy_cleanup_diagnostic(
            "launcher-directory-delete",
            launcher_result.win32_error == ERROR_SUCCESS ? "success" : "error",
            launcher_result.operation.empty() ? "delete-directory-tree" : launcher_result.operation,
            launcher_result.failed_path.empty()
                ? utf8(launcher_directory.wstring())
                : utf8(launcher_result.failed_path.wstring()),
            launcher_result.win32_error,
            HRESULT_FROM_WIN32(launcher_result.win32_error));
        if (launcher_result.win32_error != ERROR_SUCCESS)
        {
            set_legacy_cleanup_failure_context(
                launcher_result.operation.empty()
                    ? "delete-directory-tree"
                    : launcher_result.operation,
                launcher_result.failed_path.empty()
                    ? utf8(launcher_directory.wstring())
                    : utf8(launcher_result.failed_path.wstring()),
                launcher_result.win32_error);
            throw hresult_error(
                HRESULT_FROM_WIN32(launcher_result.win32_error),
                to_hstring(
                    "Unable to remove the legacy Memmy launch proxy; operation=" +
                    launcher_result.operation + "; path=" +
                    utf8(launcher_result.failed_path.wstring())));
        }
        const DWORD launcher_attributes = GetFileAttributesW(launcher_directory.c_str());
        if (launcher_attributes != INVALID_FILE_ATTRIBUTES)
        {
            set_legacy_cleanup_failure_context(
                "GetFileAttributesW(post-check)",
                utf8(launcher_directory.wstring()));
            throw hresult_error(
                E_FAIL,
                L"The legacy Memmy launch proxy directory is still present after cleanup");
        }
        const DWORD launcher_post_check_error = GetLastError();
        append_legacy_cleanup_diagnostic(
            "launcher-directory-delete",
            launcher_post_check_error == ERROR_FILE_NOT_FOUND ||
                    launcher_post_check_error == ERROR_PATH_NOT_FOUND
                ? "verified-missing"
                : "verify-error",
            "GetFileAttributesW(post-check)",
            utf8(launcher_directory.wstring()),
            launcher_post_check_error,
            HRESULT_FROM_WIN32(launcher_post_check_error));
        if (launcher_post_check_error != ERROR_FILE_NOT_FOUND &&
            launcher_post_check_error != ERROR_PATH_NOT_FOUND)
        {
            set_legacy_cleanup_failure_context(
                "GetFileAttributesW(post-check)",
                utf8(launcher_directory.wstring()),
                launcher_post_check_error);
            throw hresult_error(
                HRESULT_FROM_WIN32(launcher_post_check_error),
                L"Unable to verify removal of the legacy Memmy launch proxy directory");
        }
        complete_legacy_cleanup_operation(
            "postCheck=" + std::to_string(launcher_post_check_error));

        if (!options.shortcut_path.empty())
        {
            begin_legacy_cleanup_operation(
                "apps-folder-shortcut-create",
                utf8(options.shortcut_path.wstring()));
            create_apps_folder_shortcut(options.shortcut_path, options.aumid);
            complete_legacy_cleanup_operation();
        }
        else
        {
            append_legacy_cleanup_diagnostic(
                "apps-folder-shortcut-create",
                "skipped-no-existing-desktop-shortcut");
        }
        append_legacy_cleanup_diagnostic("cleanup-complete", "success");
    }

    void launch_store_update_finalizer_breakaway(
        const StoreInstallHandoffOptions& options)
    {
        const auto executable_path = current_executable_path();
        launch_detached_process(
            executable_path,
            build_store_finalizer_arguments(
                executable_path,
                L"launch-store-update-finalizer",
                options,
                true),
            true);
        append_handoff_log(options.log_path, "finalizer-breakaway-started");
    }

    void launch_external_store_update_finalizer(
        const StoreInstallHandoffOptions& options)
    {
        launch_detached_process(
            options.external_helper_path,
            build_store_finalizer_arguments(
                options.external_helper_path,
                L"finalize-store-update",
                options,
                false),
            false);
        append_handoff_log(options.log_path, "external-finalizer-started");
    }

    void wait_for_old_application_exit(const StoreInstallHandoffOptions& options)
    {
        const HANDLE process = OpenProcess(SYNCHRONIZE, FALSE, options.old_process_id);
        if (process == nullptr)
        {
            const DWORD error = GetLastError();
            if (error == ERROR_INVALID_PARAMETER)
            {
                return;
            }
            throw hresult_error(
                HRESULT_FROM_WIN32(error),
                L"Unable to wait for the existing Memmy process");
        }
        const DWORD wait_result = WaitForSingleObject(process, 120000);
        const DWORD wait_error = wait_result == WAIT_FAILED ? GetLastError() : ERROR_SUCCESS;
        CloseHandle(process);
        if (wait_result == WAIT_TIMEOUT)
        {
            throw hresult_error(
                HRESULT_FROM_WIN32(ERROR_TIMEOUT),
                L"Existing Memmy process did not finish its normal quit flow");
        }
        if (wait_result != WAIT_OBJECT_0)
        {
            throw hresult_error(
                HRESULT_FROM_WIN32(wait_error),
                L"Unable to observe the existing Memmy process exit");
        }
        append_handoff_log(options.log_path, "old-process-exited");
    }

    int finalize_store_update(const StoreInstallHandoffOptions& options)
    {
        if (current_process_has_package_identity())
        {
            throw hresult_error(
                E_ACCESSDENIED,
                L"Store update finalizer must run outside the application package");
        }
        append_handoff_log(
            options.log_path,
            "finalizer-monitoring",
            utf8(options.mode),
            "",
            "baselinePackageVersion=" + utf8(options.baseline_package_version) +
                "; baselinePackageFullName=" + utf8(options.baseline_package_full_name) +
                "; oldPid=" + std::to_string(options.old_process_id));
        const auto deadline = std::chrono::steady_clock::now() + std::chrono::minutes(15);
        std::string failure_state;
        std::string failure_hresult;
        std::string failure_reason;
        while (std::chrono::steady_clock::now() < deadline)
        {
            try
            {
                if (installed_package_replaced_baseline(options))
                {
                    DeleteFileW(options.state_path.c_str());
                    DeleteFileW(options.result_path.c_str());
                    append_handoff_log(options.log_path, "replacement-package-ready", "completed");
                    if (options.mode == L"manual")
                    {
                        return activate_store_application_with_retry(options, "completed") ? 0 : 3;
                    }
                    return 0;
                }
            }
            catch (const hresult_error& error)
            {
                append_handoff_log(
                    options.log_path,
                    "package-version-query-retry",
                    "",
                    hresult_text(error.code()),
                    to_string(error.message()));
            }

            const StoreInstallResultFile result = read_store_install_result(options.result_path);
            if (result.available && result.state != "completed")
            {
                failure_state = result.state.empty() ? "installer-error" : result.state;
                failure_hresult = result.hresult;
                failure_reason = result.reason.empty()
                    ? "The Microsoft Store did not complete the update"
                    : result.reason;
                break;
            }
            std::this_thread::sleep_for(std::chrono::seconds(2));
        }
        if (failure_state.empty())
        {
            failure_state = "timeout";
            failure_reason = "The Microsoft Store update did not replace the baseline package before timeout";
        }
        write_failed_store_install_state(
            options,
            failure_state,
            failure_hresult,
            failure_reason);
        append_handoff_log(
            options.log_path,
            "finalizer-failed",
            failure_state,
            failure_hresult,
            failure_reason);
        if (options.mode == L"manual")
        {
            activate_store_application_with_retry(options, "failed");
        }
        return 2;
    }

    IVector<StorePackageUpdate> copy_updates(const IVectorView<StorePackageUpdate>& updates)
    {
        auto result = single_threaded_vector<StorePackageUpdate>();
        for (const auto& update : updates)
        {
            result.Append(update);
        }
        return result;
    }

    void initialize_owner_window(const StoreContext& context, HWND owner)
    {
        if (!owner || !IsWindow(owner))
        {
            throw hresult_invalid_argument(L"A valid Electron owner window is required for this operation");
        }
        check_hresult(context.as<::IInitializeWithWindow>()->Initialize(owner));
    }

    void emit_progress(const StorePackageUpdateStatus& status)
    {
        const auto percent = std::clamp(status.TotalDownloadProgress * 100.0, 0.0, 100.0);
        std::ostringstream output;
        output << "{\"type\":\"progress\""
               << ",\"state\":\"" << update_state_name(status.PackageUpdateState) << "\""
               << ",\"transferredBytes\":" << status.PackageBytesDownloaded
               << ",\"totalBytes\":" << status.PackageDownloadSizeInBytes
               << ",\"percent\":" << std::fixed << std::setprecision(2) << percent
               << "}";
        write_json_line(output.str());
    }

    void emit_result(const StorePackageUpdateResult& result)
    {
        std::ostringstream output;
        output << "{\"type\":\"result\""
               << ",\"state\":\"" << update_state_name(result.OverallState()) << "\""
               << ",\"packages\":[";
        bool first = true;
        for (const auto& status : result.StorePackageUpdateStatuses())
        {
            if (!first)
            {
                output << ',';
            }
            first = false;
            output << "{\"family\":\"" << escape_json(to_string(status.PackageFamilyName)) << "\""
                   << ",\"state\":\"" << update_state_name(status.PackageUpdateState) << "\""
                   << ",\"transferredBytes\":" << status.PackageBytesDownloaded
                   << ",\"totalBytes\":" << status.PackageDownloadSizeInBytes
                   << "}";
        }
        output << "]}";
        write_json_line(output.str());
    }

    IAsyncOperation<StorePackageUpdateResult> run_update_operation(
        StoreContext context,
        IVector<StorePackageUpdate> updates,
        Command command)
    {
        IAsyncOperationWithProgress<StorePackageUpdateResult, StorePackageUpdateStatus> operation{nullptr};
        switch (command)
        {
        case Command::DownloadSilent:
            operation = context.TrySilentDownloadStorePackageUpdatesAsync(updates);
            break;
        case Command::DownloadUser:
            operation = context.RequestDownloadStorePackageUpdatesAsync(updates);
            break;
        default:
            throw hresult_invalid_argument(L"Unsupported update operation");
        }

        operation.Progress([](const auto&, const StorePackageUpdateStatus& status)
        {
            emit_progress(status);
        });
        co_return co_await operation;
    }

    fire_and_forget execute(Command command, HWND owner)
    {
        try
        {
            if (command == Command::Identity)
            {
                const auto package_id = Package::Current().Id();
                std::ostringstream output;
                output << "{\"type\":\"identity\""
                       << ",\"aumid\":\"" << escape_json(current_application_user_model_id()) << "\""
                       << ",\"packageFamilyName\":\"" << escape_json(to_string(package_id.FamilyName())) << "\""
                       << ",\"currentPackageFullName\":\"" << escape_json(to_string(package_id.FullName())) << "\""
                       << ",\"currentPackageVersion\":\"" << escape_json(package_version(package_id.Version())) << "\""
                       << "}";
                write_json_line(output.str());
                PostQuitMessage(0);
                co_return;
            }

            if (command == Command::StartupStatus ||
                command == Command::StartupEnable ||
                command == Command::StartupDisable)
            {
                const auto startup_task = co_await StartupTask::GetAsync(store_startup_task_id);
                StartupTaskState state = startup_task.State();
                if (command == Command::StartupEnable)
                {
                    state = co_await startup_task.RequestEnableAsync();
                }
                else if (command == Command::StartupDisable)
                {
                    startup_task.Disable();
                    state = startup_task.State();
                }

                std::ostringstream output;
                output << "{\"type\":\"startup-task\""
                       << ",\"taskId\":\"" << escape_json(to_string(startup_task.TaskId())) << "\""
                       << ",\"state\":\"" << startup_task_state_name(state) << "\""
                       << "}";
                write_json_line(output.str());
                PostQuitMessage(0);
                co_return;
            }

            const auto context = StoreContext::GetDefault();
            if (command == Command::DownloadUser)
            {
                initialize_owner_window(context, owner);
            }

            const auto updates = co_await context.GetAppAndOptionalStorePackageUpdatesAsync();
            if (command == Command::Check)
            {
                bool mandatory = false;
                for (const auto& update : updates)
                {
                    mandatory = mandatory || update.Mandatory();
                }
                const auto package_id = Package::Current().Id();

                std::ostringstream output;
                output << "{\"type\":\"check\""
                       << ",\"available\":" << (updates.Size() > 0 ? "true" : "false")
                       << ",\"updateCount\":" << updates.Size()
                       << ",\"canSilentlyDownload\":"
                       << (context.CanSilentlyDownloadStorePackageUpdates() ? "true" : "false")
                       << ",\"mandatory\":" << (mandatory ? "true" : "false")
                       << ",\"currentPackageFullName\":\"" << escape_json(to_string(package_id.FullName())) << "\""
                       << ",\"currentPackageVersion\":\"" << escape_json(package_version(package_id.Version())) << "\"";
                output << "}";
                write_json_line(output.str());
                PostQuitMessage(0);
                co_return;
            }

            if (updates.Size() == 0)
            {
                write_json_line("{\"type\":\"result\",\"state\":\"completed\",\"packages\":[]}");
                PostQuitMessage(0);
                co_return;
            }
            if (command == Command::DownloadSilent &&
                !context.CanSilentlyDownloadStorePackageUpdates())
            {
                write_json_line("{\"type\":\"result\",\"state\":\"not-allowed\",\"packages\":[]}");
                PostQuitMessage(0);
                co_return;
            }

            const auto result = co_await run_update_operation(context, copy_updates(updates), command);
            emit_result(result);
            PostQuitMessage(0);
        }
        catch (const hresult_error& error)
        {
            std::ostringstream output;
            output << "{\"type\":\"error\""
                   << ",\"hresult\":" << static_cast<int32_t>(error.code())
                   << ",\"message\":\"" << escape_json(to_string(error.message())) << "\""
                   << "}";
            write_json_line(output.str());
            PostQuitMessage(2);
        }
        catch (const std::exception& error)
        {
            write_json_line(
                "{\"type\":\"error\",\"hresult\":-1,\"message\":\"" +
                escape_json(error.what()) +
                "\"}");
            PostQuitMessage(2);
        }
    }

    fire_and_forget execute_store_install_handoff(StoreInstallHandoffOptions options)
    {
        try
        {
            const auto context = StoreContext::GetDefault();
            const auto updates = co_await context.GetAppAndOptionalStorePackageUpdatesAsync();
            append_handoff_log(
                options.log_path,
                "store-updates-found",
                utf8(options.mode),
                "",
                "baselinePackageVersion=" + utf8(options.baseline_package_version) +
                    "; updateCount=" + std::to_string(updates.Size()));
            if (updates.Size() == 0)
            {
                write_store_install_result(
                    options,
                    "no-update",
                    "",
                    "The Microsoft Store returned no update for the baseline package");
                PostQuitMessage(2);
                co_return;
            }

            append_handoff_log(
                options.log_path,
                "install-operation-started",
                utf8(options.mode),
                "",
                "baselinePackageVersion=" + utf8(options.baseline_package_version));
            auto operation = context.TrySilentDownloadAndInstallStorePackageUpdatesAsync(
                copy_updates(updates));
            operation.Progress([log_path = options.log_path](
                const auto&,
                const StorePackageUpdateStatus& status)
            {
                append_store_package_log(log_path, "install-progress", status);
            });
            const StorePackageUpdateResult result = co_await operation;
            const std::string state = update_state_name(result.OverallState());
            for (const auto& status : result.StorePackageUpdateStatuses())
            {
                append_store_package_log(options.log_path, "install-package-result", status);
            }
            emit_result(result);
            write_store_install_result(
                options,
                state,
                "",
                state == "completed"
                    ? ""
                    : "The Microsoft Store silent install did not complete");
            PostQuitMessage(state == "completed" ? 0 : 2);
        }
        catch (const hresult_error& error)
        {
            const std::string code = hresult_text(error.code());
            const std::string reason = single_line(to_string(error.message()));
            try
            {
                write_store_install_result(options, "exception", code, reason);
            }
            catch (...)
            {
            }
            PostQuitMessage(2);
        }
        catch (const std::exception& error)
        {
            const std::string reason = single_line(error.what());
            try
            {
                write_store_install_result(options, "exception", "0xFFFFFFFF", reason);
            }
            catch (...)
            {
            }
            PostQuitMessage(2);
        }
    }

    Command parse_command(const std::wstring& value)
    {
        if (value == L"identity")
        {
            return Command::Identity;
        }
        if (value == L"package-family-registration")
        {
            return Command::PackageFamilyRegistration;
        }
        if (value == L"check")
        {
            return Command::Check;
        }
        if (value == L"download-silent")
        {
            return Command::DownloadSilent;
        }
        if (value == L"download-user")
        {
            return Command::DownloadUser;
        }
        if (value == L"handoff-install")
        {
            return Command::HandoffInstall;
        }
        if (value == L"launch-store-update-finalizer")
        {
            return Command::LaunchStoreUpdateFinalizer;
        }
        if (value == L"finalize-store-update")
        {
            return Command::FinalizeStoreUpdate;
        }
        if (value == L"startup-status")
        {
            return Command::StartupStatus;
        }
        if (value == L"startup-enable")
        {
            return Command::StartupEnable;
        }
        if (value == L"startup-disable")
        {
            return Command::StartupDisable;
        }
        if (value == L"prepare-legacy-takeover")
        {
            return Command::PrepareLegacyTakeover;
        }
        if (value == L"finalize-legacy-cleanup")
        {
            return Command::FinalizeLegacyCleanup;
        }
        if (value == L"finalize-legacy-cleanup-breakaway-launcher")
        {
            return Command::FinalizeLegacyCleanupBreakawayLauncher;
        }
        if (value == L"finalize-legacy-cleanup-unpackaged")
        {
            return Command::FinalizeLegacyCleanupUnpackaged;
        }
        throw hresult_invalid_argument(L"Unknown command");
    }

    bool is_legacy_transition_command(Command command)
    {
        return command == Command::PrepareLegacyTakeover ||
            command == Command::FinalizeLegacyCleanup ||
            command == Command::FinalizeLegacyCleanupBreakawayLauncher ||
            command == Command::FinalizeLegacyCleanupUnpackaged;
    }

    bool is_legacy_cleanup_diagnostic_command(Command command)
    {
        return command == Command::FinalizeLegacyCleanup ||
            command == Command::FinalizeLegacyCleanupBreakawayLauncher ||
            command == Command::FinalizeLegacyCleanupUnpackaged;
    }

    bool has_handoff_options(const StoreInstallHandoffOptions& options)
    {
        return !options.external_helper_path.empty() ||
            !options.state_path.empty() ||
            !options.result_path.empty() ||
            !options.log_path.empty() ||
            options.old_process_id != 0 ||
            !options.baseline_package_version.empty() ||
            !options.baseline_package_full_name.empty() ||
            !options.created_at.empty() ||
            !options.aumid.empty() ||
            !options.package_family_name.empty() ||
            !options.mode.empty();
    }

    int run_message_loop()
    {
        MSG message{};
        while (GetMessageW(&message, nullptr, 0, 0) > 0)
        {
            TranslateMessage(&message);
            DispatchMessageW(&message);
        }
        return static_cast<int>(message.wParam);
    }
}

int wmain(int argc, wchar_t* argv[])
{
    std::optional<Command> active_command;
    try
    {
        if (argc < 2)
        {
            std::cerr << "usage: MemmyStoreUpdate.exe <identity|package-family-registration|check|download-silent|download-user|handoff-install|launch-store-update-finalizer|finalize-store-update|startup-status|startup-enable|startup-disable|prepare-legacy-takeover|finalize-legacy-cleanup> [options]\n";
            return 64;
        }

        const Command command = parse_command(argv[1]);
        active_command = command;
        HWND owner = nullptr;
        StoreInstallHandoffOptions options;
        LegacyTransitionOptions legacy_options;
        std::wstring registration_package_family_name;
        for (int index = 2; index < argc; ++index)
        {
            const std::wstring argument = argv[index];
            const auto require_value = [&]() -> const wchar_t*
            {
                if (index + 1 >= argc)
                {
                    throw hresult_invalid_argument(L"Command option is missing its value");
                }
                return argv[++index];
            };

            if (command == Command::PackageFamilyRegistration)
            {
                if (argument != L"--package-family-name")
                {
                    throw hresult_invalid_argument(
                        L"Package-family registration accepts only --package-family-name");
                }
                if (!registration_package_family_name.empty())
                {
                    throw hresult_invalid_argument(
                        L"--package-family-name may be specified only once");
                }
                registration_package_family_name = require_value();
                if (registration_package_family_name.empty())
                {
                    throw hresult_invalid_argument(L"Package family name is required");
                }
                continue;
            }

            if (argument == L"--hwnd")
            {
                owner = parse_window_handle(require_value());
                continue;
            }
            if (argument == L"--external-helper-path")
            {
                if (is_legacy_transition_command(command))
                {
                    legacy_options.external_helper_path = require_value();
                }
                else
                {
                    options.external_helper_path = require_value();
                }
                continue;
            }
            if (argument == L"--legacy-install-directory")
            {
                legacy_options.legacy_install_directory = require_value();
                continue;
            }
            if (argument == L"--legacy-executable-path")
            {
                legacy_options.legacy_executable_path = require_value();
                continue;
            }
            if (argument == L"--shortcut")
            {
                legacy_options.shortcut_path = require_value();
                continue;
            }
            if (argument == L"--state-path")
            {
                options.state_path = require_value();
                continue;
            }
            if (argument == L"--result-path")
            {
                options.result_path = require_value();
                continue;
            }
            if (argument == L"--log-path")
            {
                options.log_path = require_value();
                continue;
            }
            if (argument == L"--old-pid")
            {
                options.old_process_id = parse_process_id(require_value());
                continue;
            }
            if (argument == L"--baseline-package-version")
            {
                options.baseline_package_version = require_value();
                continue;
            }
            if (argument == L"--baseline-package-full-name")
            {
                options.baseline_package_full_name = require_value();
                continue;
            }
            if (argument == L"--created-at")
            {
                options.created_at = require_value();
                continue;
            }
            if (argument == L"--aumid")
            {
                if (is_legacy_transition_command(command))
                {
                    legacy_options.aumid = require_value();
                }
                else
                {
                    options.aumid = require_value();
                }
                continue;
            }
            if (argument == L"--package-family-name")
            {
                if (is_legacy_transition_command(command))
                {
                    legacy_options.package_family_name = require_value();
                }
                else
                {
                    options.package_family_name = require_value();
                }
                continue;
            }
            if (argument == L"--transition-id")
            {
                if (!is_legacy_transition_command(command))
                {
                    throw hresult_invalid_argument(
                        L"--transition-id is only valid for legacy cleanup");
                }
                legacy_options.transition_id = require_value();
                continue;
            }
            if (argument == L"--attempt-id")
            {
                if (!is_legacy_transition_command(command))
                {
                    throw hresult_invalid_argument(
                        L"--attempt-id is only valid for legacy cleanup");
                }
                legacy_options.attempt_id = require_value();
                continue;
            }
            if (argument == L"--mode")
            {
                options.mode = require_value();
                continue;
            }
            throw hresult_invalid_argument(L"Unknown argument");
        }

        if (command == Command::PackageFamilyRegistration)
        {
            if (!is_valid_package_family_name(registration_package_family_name))
            {
                throw hresult_invalid_argument(
                    L"package-family-registration requires a valid --package-family-name");
            }
            emit_package_family_registration(registration_package_family_name);
            return 0;
        }

        init_apartment(apartment_type::single_threaded);
        if (command == Command::PrepareLegacyTakeover)
        {
            validate_legacy_transition_options(legacy_options, false, false);
            if (!legacy_options.external_helper_path.empty() ||
                !legacy_options.shortcut_path.empty() ||
                !legacy_options.aumid.empty() ||
                !legacy_options.package_family_name.empty() ||
                !legacy_options.transition_id.empty() ||
                !legacy_options.attempt_id.empty())
            {
                throw hresult_invalid_argument(L"Legacy takeover arguments are invalid");
            }
            prepare_legacy_takeover(legacy_options);
            return 0;
        }
        if (command == Command::FinalizeLegacyCleanup)
        {
            initialize_legacy_cleanup_diagnostics(legacy_options, "packaged-helper");
            begin_legacy_cleanup_operation("options-validate");
            validate_legacy_transition_options(legacy_options, true, true);
            complete_legacy_cleanup_operation();
            begin_legacy_cleanup_operation(
                "identity-query",
                utf8(current_executable_path().wstring()));
            if (!current_process_has_package_identity())
            {
                throw hresult_error(
                    E_ACCESSDENIED,
                    L"Legacy cleanup entry point must retain application package identity");
            }
            complete_legacy_cleanup_operation("requiredPackageIdentity=true");
            const std::filesystem::path executable_path = current_executable_path();
            begin_legacy_cleanup_operation(
                "child-breakaway-launch",
                utf8(executable_path.wstring()));
            run_legacy_cleanup_process(
                executable_path,
                build_legacy_cleanup_arguments(
                    executable_path,
                    L"finalize-legacy-cleanup-breakaway-launcher",
                    legacy_options,
                    true),
                true);
            complete_legacy_cleanup_operation();
            append_legacy_cleanup_diagnostic("process-complete", "success");
            return 0;
        }
        if (command == Command::FinalizeLegacyCleanupBreakawayLauncher)
        {
            initialize_legacy_cleanup_diagnostics(legacy_options, "breakaway-launcher");
            begin_legacy_cleanup_operation("options-validate");
            validate_legacy_transition_options(legacy_options, true, true);
            complete_legacy_cleanup_operation();
            begin_legacy_cleanup_operation(
                "identity-query",
                utf8(current_executable_path().wstring()));
            const bool breakaway_launcher_has_package_identity =
                current_process_has_package_identity();
            // BREAKAWAY_OVERRIDE keeps this launcher inside the desktop-app
            // runtime; ENABLE_PROCESS_TREE applies to the child it creates.
            // The external child below still enforces that destructive cleanup
            // is unpackaged.
            complete_legacy_cleanup_operation(
                std::string("breakawayLauncherHasPackageIdentity=") +
                (breakaway_launcher_has_package_identity ? "true" : "false") +
                "; breakawayPolicyAppliesToChildCreation=true");
            begin_legacy_cleanup_operation(
                "child-external-launch",
                utf8(legacy_options.external_helper_path.wstring()));
            run_legacy_cleanup_process(
                legacy_options.external_helper_path,
                build_legacy_cleanup_arguments(
                    legacy_options.external_helper_path,
                    L"finalize-legacy-cleanup-unpackaged",
                    legacy_options,
                    false),
                false);
            complete_legacy_cleanup_operation();
            append_legacy_cleanup_diagnostic("process-complete", "success");
            return 0;
        }
        if (command == Command::FinalizeLegacyCleanupUnpackaged)
        {
            initialize_legacy_cleanup_diagnostics(
                legacy_options,
                "external-unpackaged-helper");
            begin_legacy_cleanup_operation("options-validate");
            validate_legacy_transition_options(legacy_options, true, false);
            if (!legacy_options.external_helper_path.empty())
            {
                throw hresult_invalid_argument(L"Unpackaged legacy cleanup received an external helper path");
            }
            complete_legacy_cleanup_operation();
            finalize_legacy_cleanup_unpacked(legacy_options);
            append_legacy_cleanup_diagnostic("process-complete", "success");
            return 0;
        }
        if (command == Command::HandoffInstall)
        {
            if (owner != nullptr)
            {
                throw hresult_invalid_argument(L"--hwnd is invalid for Store install handoff");
            }
            validate_store_install_handoff_options(options, true);
            if (!current_process_has_package_identity())
            {
                throw hresult_error(
                    E_ACCESSDENIED,
                    L"Store update installer must retain application package identity");
            }
            append_handoff_log(
                options.log_path,
                "handoff-installer-started",
                utf8(options.mode),
                "",
                "baselinePackageVersion=" + utf8(options.baseline_package_version) +
                    "; oldPid=" + std::to_string(options.old_process_id));
            try
            {
                launch_store_update_finalizer_breakaway(options);
            }
            catch (const hresult_error& error)
            {
                const std::string code = hresult_text(error.code());
                const std::string reason = single_line(to_string(error.message()));
                write_store_install_result(options, "finalizer-start-failed", code, reason);
                write_failed_store_install_state(
                    options,
                    "finalizer-start-failed",
                    code,
                    reason);
                try
                {
                    wait_for_old_application_exit(options);
                    if (options.mode == L"manual")
                    {
                        activate_store_application_with_retry(
                            options,
                            "finalizer-start-failed");
                    }
                }
                catch (...)
                {
                }
                return 2;
            }
            try
            {
                wait_for_old_application_exit(options);
            }
            catch (const hresult_error& error)
            {
                write_store_install_result(
                    options,
                    "old-process-exit-failed",
                    hresult_text(error.code()),
                    single_line(to_string(error.message())));
                return 2;
            }
            execute_store_install_handoff(options);
            return run_message_loop();
        }

        if (command == Command::LaunchStoreUpdateFinalizer)
        {
            if (owner != nullptr)
            {
                throw hresult_invalid_argument(L"--hwnd is invalid for Store update finalization");
            }
            validate_store_install_handoff_options(options, true);
            launch_external_store_update_finalizer(options);
            return 0;
        }

        if (command == Command::FinalizeStoreUpdate)
        {
            if (owner != nullptr)
            {
                throw hresult_invalid_argument(L"--hwnd is invalid for Store update finalization");
            }
            validate_store_install_handoff_options(options, false);
            return finalize_store_update(options);
        }

        if (has_handoff_options(options))
        {
            throw hresult_invalid_argument(L"Store install handoff arguments are invalid for this command");
        }
        if (owner != nullptr && command != Command::DownloadUser)
        {
            throw hresult_invalid_argument(L"--hwnd is only valid for download-user");
        }

        execute(command, owner);
        return run_message_loop();
    }
    catch (const hresult_error& error)
    {
        const std::string message = to_string(error.message());
        write_legacy_cleanup_process_failure(error.code(), message);
        write_legacy_cleanup_error_to_stderr(error.code(), message);
        return active_command && is_legacy_cleanup_diagnostic_command(*active_command)
            ? static_cast<int>(error.code())
            : 2;
    }
    catch (const std::filesystem::filesystem_error& error)
    {
        const DWORD win32_error = static_cast<DWORD>(error.code().value());
        const HRESULT hresult = HRESULT_FROM_WIN32(win32_error);
        const std::string target = !error.path1().empty()
            ? utf8(error.path1().wstring())
            : (!error.path2().empty() ? utf8(error.path2().wstring()) : "");
        set_legacy_cleanup_failure_context(
            "std::filesystem",
            target,
            win32_error);
        const std::string message = error.what();
        write_legacy_cleanup_process_failure(hresult, message);
        write_legacy_cleanup_error_to_stderr(hresult, message);
        return active_command && is_legacy_cleanup_diagnostic_command(*active_command)
            ? static_cast<int>(hresult)
            : 2;
    }
    catch (const std::exception& error)
    {
        const HRESULT hresult = static_cast<HRESULT>(-1);
        const std::string message = error.what();
        write_legacy_cleanup_process_failure(hresult, message);
        write_legacy_cleanup_error_to_stderr(hresult, message);
        return active_command && is_legacy_cleanup_diagnostic_command(*active_command)
            ? static_cast<int>(hresult)
            : 2;
    }
}
