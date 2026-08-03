#include <windows.h>
#include <appmodel.h>
#include <shlobj_core.h>
#include <shobjidl_core.h>
#include <tlhelp32.h>

#include <algorithm>
#include <array>
#include <cstdint>
#include <cwctype>
#include <filesystem>
#include <iomanip>
#include <iostream>
#include <sstream>
#include <string>
#include <string_view>
#include <unordered_map>
#include <unordered_set>
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
        Check,
        DownloadSilent,
        DownloadUser,
        InstallSilent,
        InstallUser,
        PrepareLegacyTakeover,
        FinalizeLegacyCleanup,
        FinalizeLegacyCleanupBreakawayLauncher,
        FinalizeLegacyCleanupUnpackaged
    };

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

    std::string package_version(const PackageVersion& version)
    {
        std::ostringstream output;
        output << version.Major << '.'
               << version.Minor << '.'
               << version.Build << '.'
               << version.Revision;
        return output.str();
    }

    bool is_version_greater(const PackageVersion& left, const PackageVersion& right)
    {
        return std::array<uint16_t, 4>{left.Major, left.Minor, left.Build, left.Revision} >
            std::array<uint16_t, 4>{right.Major, right.Minor, right.Build, right.Revision};
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

    std::filesystem::path resolve_legacy_install_directory()
    {
        return resolve_environment_path(
            L"LOCALAPPDATA",
            L"LOCALAPPDATA is unavailable for legacy cleanup") /
            L"Programs" /
            L"Memmy";
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
        if (Process32FirstW(snapshot, &entry))
        {
            do
            {
                processes.push_back({
                    entry.th32ProcessID,
                    entry.th32ParentProcessID,
                    query_process_creation_time(entry.th32ProcessID)
                });
            } while (Process32NextW(snapshot, &entry));
        }
        else
        {
            const DWORD error = GetLastError();
            CloseHandle(snapshot);
            throw hresult_error(
                HRESULT_FROM_WIN32(error),
                L"Unable to read the process snapshot for legacy takeover");
        }
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
            if (!process.image_path_verified)
            {
                continue;
            }
            if (!is_windows_apps_path(process.image_path) &&
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
                if (parent == processes_by_id.end())
                {
                    continue;
                }
                const auto& parent_process = parent->second;
                if (process.creation_time == 0 ||
                    parent_process.creation_time == 0 ||
                    process.creation_time < parent_process.creation_time ||
                    !process.image_path_verified ||
                    is_windows_apps_path(process.image_path))
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
                query_process_creation_time(process) != target.creation_time)
            {
                CloseHandle(process);
                continue;
            }
            if (WaitForSingleObject(process, 0) != WAIT_TIMEOUT)
            {
                CloseHandle(process);
                continue;
            }
            std::filesystem::path current_image_path;
            if (!try_query_process_image_path(process, current_image_path))
            {
                const DWORD error = GetLastError();
                if (WaitForSingleObject(process, 0) != WAIT_TIMEOUT)
                {
                    CloseHandle(process);
                    continue;
                }
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
                if (WaitForSingleObject(process, 0) != WAIT_TIMEOUT)
                {
                    CloseHandle(process);
                    continue;
                }
                CloseHandle(process);
                throw hresult_error(
                    HRESULT_FROM_WIN32(error),
                    L"Unable to terminate a validated legacy Memmy process");
            }
            WaitForSingleObject(process, 3000);
            CloseHandle(process);
        }
    }

    void prepare_legacy_takeover(
        const std::filesystem::path& legacy_install_directory)
    {
        const std::filesystem::path expected_directory =
            resolve_legacy_install_directory();
        if (normalize_absolute_path(legacy_install_directory) !=
            normalize_absolute_path(expected_directory))
        {
            throw hresult_invalid_argument(
                L"Refusing to take over an unexpected legacy install directory");
        }

        constexpr int maximum_scan_rounds = 8;
        constexpr int required_empty_rounds = 3;
        int empty_rounds = 0;
        for (int round = 0; round < maximum_scan_rounds; ++round)
        {
            const auto targets = find_legacy_process_tree(expected_directory);
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

        if (!find_legacy_process_tree(expected_directory).empty())
        {
            throw hresult_error(
                HRESULT_FROM_WIN32(ERROR_BUSY),
                L"Legacy Memmy processes restarted during Store takeover");
        }
    }

    DWORD delete_directory_tree_once(const std::filesystem::path& path)
    {
        const DWORD attributes = GetFileAttributesW(path.c_str());
        if (attributes == INVALID_FILE_ATTRIBUTES)
        {
            const DWORD error = GetLastError();
            return error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND
                ? ERROR_SUCCESS
                : error;
        }

        if ((attributes & FILE_ATTRIBUTE_READONLY) != 0)
        {
            SetFileAttributesW(path.c_str(), attributes & ~FILE_ATTRIBUTE_READONLY);
        }
        if ((attributes & FILE_ATTRIBUTE_DIRECTORY) == 0)
        {
            return DeleteFileW(path.c_str()) ? ERROR_SUCCESS : GetLastError();
        }
        if ((attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0)
        {
            return RemoveDirectoryW(path.c_str()) ? ERROR_SUCCESS : GetLastError();
        }

        WIN32_FIND_DATAW entry{};
        const std::filesystem::path search_path = path / L"*";
        HANDLE search = FindFirstFileW(search_path.c_str(), &entry);
        if (search == INVALID_HANDLE_VALUE)
        {
            const DWORD error = GetLastError();
            return error == ERROR_FILE_NOT_FOUND ? ERROR_SUCCESS : error;
        }

        DWORD result = ERROR_SUCCESS;
        do
        {
            if (wcscmp(entry.cFileName, L".") == 0 || wcscmp(entry.cFileName, L"..") == 0)
            {
                continue;
            }
            result = delete_directory_tree_once(path / entry.cFileName);
            if (result != ERROR_SUCCESS)
            {
                break;
            }
        } while (FindNextFileW(search, &entry));
        if (result == ERROR_SUCCESS)
        {
            const DWORD enumeration_error = GetLastError();
            if (enumeration_error != ERROR_NO_MORE_FILES)
            {
                result = enumeration_error;
            }
        }
        FindClose(search);
        if (result != ERROR_SUCCESS)
        {
            return result;
        }
        return RemoveDirectoryW(path.c_str()) ? ERROR_SUCCESS : GetLastError();
    }

    void remove_legacy_install_directory()
    {
        const std::filesystem::path legacy_install_directory =
            resolve_legacy_install_directory();
        if (!legacy_install_directory.is_absolute() ||
            legacy_install_directory.filename() != L"Memmy" ||
            legacy_install_directory.parent_path().filename() != L"Programs")
        {
            throw hresult_invalid_argument(L"Refusing to remove an unexpected legacy install directory");
        }

        DWORD result = ERROR_SUCCESS;
        constexpr int maximum_attempts = 20;
        for (int attempt = 0; attempt < maximum_attempts; ++attempt)
        {
            if (attempt > 0)
            {
                prepare_legacy_takeover(legacy_install_directory);
            }
            result = delete_directory_tree_once(legacy_install_directory);
            if (result == ERROR_SUCCESS)
            {
                return;
            }
            Sleep(250);
        }
        throw hresult_error(
            HRESULT_FROM_WIN32(result),
            L"Unable to remove the legacy Memmy install directory");
    }

    void delete_registry_tree_if_present(const wchar_t* key_path)
    {
        const LSTATUS result = RegDeleteTreeW(HKEY_CURRENT_USER, key_path);
        if (result != ERROR_SUCCESS &&
            result != ERROR_FILE_NOT_FOUND &&
            result != ERROR_PATH_NOT_FOUND)
        {
            check_hresult(HRESULT_FROM_WIN32(result));
        }
    }

    bool registry_tree_exists(const wchar_t* key_path)
    {
        HKEY key = nullptr;
        const LSTATUS result = RegOpenKeyExW(
            HKEY_CURRENT_USER,
            key_path,
            0,
            KEY_READ,
            &key);
        if (result == ERROR_SUCCESS)
        {
            RegCloseKey(key);
            return true;
        }
        if (result == ERROR_FILE_NOT_FOUND || result == ERROR_PATH_NOT_FOUND)
        {
            return false;
        }
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
        if (delete_result != ERROR_SUCCESS && delete_result != ERROR_FILE_NOT_FOUND)
        {
            check_hresult(HRESULT_FROM_WIN32(delete_result));
        }
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

    std::filesystem::path validate_unpacked_cleanup_helper_path(
        const std::filesystem::path& helper_path)
    {
        const std::filesystem::path expected_path =
            resolve_environment_path(
                L"LOCALAPPDATA",
                L"LOCALAPPDATA is unavailable for legacy cleanup") /
            L"Memmy" /
            L"launcher" /
            L"MemmyStoreUpdate.exe";
        if (normalize_absolute_path(helper_path) != normalize_absolute_path(expected_path) ||
            helper_path.filename() != L"MemmyStoreUpdate.exe" ||
            is_windows_apps_path(helper_path) ||
            !std::filesystem::is_regular_file(helper_path))
        {
            throw hresult_invalid_argument(
                L"Refusing to use an unexpected unpackaged legacy cleanup helper");
        }
        return expected_path;
    }

    void run_cleanup_command(
        const std::filesystem::path& executable_path,
        const std::wstring& command,
        const std::wstring& shortcut_path,
        const std::wstring& aumid,
        const std::wstring& unpackaged_helper_path,
        bool set_desktop_app_policy,
        DWORD desktop_app_policy = 0)
    {
        std::vector<std::wstring> arguments{
            executable_path.wstring(),
            command
        };
        if (!unpackaged_helper_path.empty())
        {
            arguments.insert(arguments.end(), {
                L"--unpackaged-helper-path",
                unpackaged_helper_path
            });
        }
        if (!shortcut_path.empty() || !aumid.empty())
        {
            arguments.insert(arguments.end(), {
                L"--shortcut",
                shortcut_path,
                L"--aumid",
                aumid
            });
        }

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
        if (set_desktop_app_policy)
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
                    L"Unable to initialize the desktop app breakaway policy");
            }
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
                    L"Unable to set the desktop app breakaway policy");
            }
        }

        PROCESS_INFORMATION process{};
        const DWORD creation_flags = CREATE_NO_WINDOW |
            (set_desktop_app_policy ? EXTENDED_STARTUPINFO_PRESENT : 0);
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
                L"Unable to start unpackaged legacy cleanup");
        }

        CloseHandle(process.hThread);
        const DWORD wait_result = WaitForSingleObject(process.hProcess, 30000);
        if (wait_result == WAIT_TIMEOUT)
        {
            TerminateProcess(process.hProcess, ERROR_TIMEOUT);
            WaitForSingleObject(process.hProcess, 5000);
            CloseHandle(process.hProcess);
            throw hresult_error(
                HRESULT_FROM_WIN32(ERROR_TIMEOUT),
                L"Unpackaged legacy cleanup timed out");
        }
        if (wait_result != WAIT_OBJECT_0)
        {
            const DWORD wait_error = GetLastError();
            CloseHandle(process.hProcess);
            throw hresult_error(
                HRESULT_FROM_WIN32(wait_error),
                L"Unable to wait for unpackaged legacy cleanup");
        }

        DWORD exit_code = ERROR_GEN_FAILURE;
        const BOOL read_exit_code = GetExitCodeProcess(process.hProcess, &exit_code);
        const DWORD exit_code_error = read_exit_code ? ERROR_SUCCESS : GetLastError();
        CloseHandle(process.hProcess);
        if (!read_exit_code)
        {
            throw hresult_error(
                HRESULT_FROM_WIN32(exit_code_error),
                L"Unable to read the unpackaged legacy cleanup result");
        }
        if (exit_code != 0)
        {
            throw hresult_error(
                E_FAIL,
                L"Unpackaged legacy cleanup failed");
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
        if (value.size() >= 2 && value.front() == L'"' && value.back() == L'"')
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

    void remove_legacy_cli_from_user_path()
    {
        std::array<wchar_t, 32768> local_app_data{};
        const DWORD local_app_data_length = GetEnvironmentVariableW(
            L"LOCALAPPDATA",
            local_app_data.data(),
            static_cast<DWORD>(local_app_data.size()));
        if (local_app_data_length == 0 || local_app_data_length >= local_app_data.size())
        {
            return;
        }
        const std::wstring target = normalize_path_component(
            std::wstring(local_app_data.data(), local_app_data_length) +
            L"\\Programs\\Memmy\\resources\\cli");

        HKEY environment_key = nullptr;
        const LSTATUS open_result = RegOpenKeyExW(
            HKEY_CURRENT_USER,
            L"Environment",
            0,
            KEY_QUERY_VALUE | KEY_SET_VALUE,
            &environment_key);
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
        if (read_result == ERROR_FILE_NOT_FOUND)
        {
            RegCloseKey(environment_key);
            return;
        }
        if (read_result != ERROR_SUCCESS)
        {
            RegCloseKey(environment_key);
            check_hresult(HRESULT_FROM_WIN32(read_result));
        }
        if (value_type != REG_SZ && value_type != REG_EXPAND_SZ)
        {
            RegCloseKey(environment_key);
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
            if (write_result != ERROR_SUCCESS)
            {
                check_hresult(HRESULT_FROM_WIN32(write_result));
            }
            DWORD_PTR message_result = 0;
            SendMessageTimeoutW(
                HWND_BROADCAST,
                WM_SETTINGCHANGE,
                0,
                reinterpret_cast<LPARAM>(L"Environment"),
                SMTO_ABORTIFHUNG,
                5000,
                &message_result);
            return;
        }
        RegCloseKey(environment_key);
    }

    void create_apps_folder_shortcut(
        const std::filesystem::path& shortcut_path,
        const std::wstring& aumid)
    {
        com_ptr<IShellItem> apps_folder;
        check_hresult(SHGetKnownFolderItem(
            FOLDERID_AppsFolder,
            KF_FLAG_DEFAULT,
            nullptr,
            IID_PPV_ARGS(apps_folder.put())));

        com_ptr<IShellItem> application_item;
        check_hresult(SHCreateItemFromRelativeName(
            apps_folder.get(),
            aumid.c_str(),
            nullptr,
            IID_PPV_ARGS(application_item.put())));

        PIDLIST_ABSOLUTE full_item_id = nullptr;
        check_hresult(SHGetIDListFromObject(application_item.get(), &full_item_id));
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
            throw hresult_error(E_NOTIMPL, L"Windows shell link creation is unavailable");
        }

        std::error_code remove_error;
        std::filesystem::remove(shortcut_path, remove_error);
        PIDLIST_ABSOLUTE created_item_id = nullptr;
        const HRESULT link_result = create_links(
            nullptr,
            shortcut_path.parent_path().c_str(),
            data_object.get(),
            0,
            &created_item_id);
        if (created_item_id)
        {
            CoTaskMemFree(created_item_id);
        }
        check_hresult(link_result);
        if (!std::filesystem::exists(shortcut_path))
        {
            throw hresult_error(E_FAIL, L"Windows did not create the expected Memmy desktop shortcut");
        }
    }

    bool shortcut_targets_aumid(
        const std::filesystem::path& shortcut_path,
        const std::wstring& aumid)
    {
        const HANDLE file = CreateFileW(
            shortcut_path.c_str(),
            GENERIC_READ,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            nullptr,
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL,
            nullptr);
        if (file == INVALID_HANDLE_VALUE)
        {
            return false;
        }

        LARGE_INTEGER size{};
        if (!GetFileSizeEx(file, &size) ||
            size.QuadPart <= 0 ||
            size.QuadPart > 1024 * 1024)
        {
            CloseHandle(file);
            return false;
        }

        std::vector<std::byte> contents(static_cast<size_t>(size.QuadPart));
        DWORD bytes_read = 0;
        const BOOL read_result = ReadFile(
            file,
            contents.data(),
            static_cast<DWORD>(contents.size()),
            &bytes_read,
            nullptr);
        CloseHandle(file);
        if (!read_result || bytes_read != contents.size())
        {
            return false;
        }

        const auto* aumid_bytes = reinterpret_cast<const std::byte*>(aumid.data());
        const size_t aumid_byte_count = aumid.size() * sizeof(wchar_t);
        return std::search(
            contents.begin(),
            contents.end(),
            aumid_bytes,
            aumid_bytes + aumid_byte_count) != contents.end();
    }

    void finalize_legacy_cleanup(
        const std::wstring& shortcut_path,
        const std::wstring& aumid)
    {
        constexpr wchar_t legacy_uninstall_key[] =
            L"Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\"
            L"886615f7-a04c-57ec-a2dd-9161dbe1a7c4";
        constexpr wchar_t legacy_installer_key[] =
            L"Software\\886615f7-a04c-57ec-a2dd-9161dbe1a7c4";
        constexpr wchar_t run_key[] =
            L"Software\\Microsoft\\Windows\\CurrentVersion\\Run";
        prepare_legacy_takeover(resolve_legacy_install_directory());
        remove_legacy_install_directory();
        delete_registry_tree_if_present(legacy_uninstall_key);
        delete_registry_tree_if_present(legacy_installer_key);
        if (registry_tree_exists(legacy_uninstall_key) ||
            registry_tree_exists(legacy_installer_key))
        {
            throw hresult_error(
                E_FAIL,
                L"Legacy uninstall registration is still present after cleanup");
        }
        delete_registry_value_if_present(run_key, L"Memmy");
        delete_registry_value_if_present(run_key, L"memmy");
        remove_legacy_cli_from_user_path();

        if (shortcut_path.empty() && aumid.empty())
        {
            return;
        }
        if (shortcut_path.empty() || aumid.empty() || !is_valid_aumid(aumid))
        {
            throw hresult_invalid_argument(L"A valid --shortcut and --aumid must be provided together");
        }

        const std::filesystem::path shortcut(shortcut_path);
        if (!shortcut.is_absolute() || shortcut.filename() != L"Memmy.lnk")
        {
            throw hresult_invalid_argument(L"--shortcut must be an absolute path ending in Memmy.lnk");
        }

        if (!shortcut_targets_aumid(shortcut, aumid))
        {
            create_apps_folder_shortcut(shortcut, aumid);
        }
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
        const StoreContext& context,
        const IVector<StorePackageUpdate>& updates,
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
        case Command::InstallSilent:
            operation = context.TrySilentDownloadAndInstallStorePackageUpdatesAsync(updates);
            break;
        case Command::InstallUser:
            operation = context.RequestDownloadAndInstallStorePackageUpdatesAsync(updates);
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
                write_json_line(
                    "{\"type\":\"identity\",\"aumid\":\"" +
                    escape_json(current_application_user_model_id()) +
                    "\"}");
                PostQuitMessage(0);
                co_return;
            }

            const auto context = StoreContext::GetDefault();
            if (command == Command::DownloadUser || command == Command::InstallUser)
            {
                initialize_owner_window(context, owner);
            }

            const auto updates = co_await context.GetAppAndOptionalStorePackageUpdatesAsync();
            if (command == Command::Check)
            {
                std::string latest_version;
                PackageVersion latest_package_version{};
                bool has_latest_version = false;
                bool mandatory = false;
                for (const auto& update : updates)
                {
                    const auto version = update.Package().Id().Version();
                    if (!has_latest_version || is_version_greater(version, latest_package_version))
                    {
                        latest_package_version = version;
                        latest_version = package_version(version);
                        has_latest_version = true;
                    }
                    mandatory = mandatory || update.Mandatory();
                }

                std::ostringstream output;
                output << "{\"type\":\"check\""
                       << ",\"available\":" << (updates.Size() > 0 ? "true" : "false")
                       << ",\"updateCount\":" << updates.Size()
                       << ",\"canSilentlyDownload\":"
                       << (context.CanSilentlyDownloadStorePackageUpdates() ? "true" : "false")
                       << ",\"mandatory\":" << (mandatory ? "true" : "false");
                if (!latest_version.empty())
                {
                    output << ",\"latestVersion\":\"" << escape_json(latest_version) << "\"";
                }
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

    Command parse_command(const std::wstring& value)
    {
        if (value == L"identity")
        {
            return Command::Identity;
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
        if (value == L"install-silent")
        {
            return Command::InstallSilent;
        }
        if (value == L"install-user")
        {
            return Command::InstallUser;
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
}

int wmain(int argc, wchar_t* argv[])
{
    try
    {
        if (argc < 2)
        {
            std::cerr << "usage: MemmyStoreUpdate.exe <identity|check|download-silent|download-user|install-silent|install-user|prepare-legacy-takeover|finalize-legacy-cleanup> [options]\n";
            return 64;
        }

        const Command command = parse_command(argv[1]);
        HWND owner = nullptr;
        std::wstring shortcut_path;
        std::wstring aumid;
        std::wstring legacy_install_directory;
        std::wstring unpackaged_helper_path;
        for (int index = 2; index < argc; ++index)
        {
            const std::wstring argument = argv[index];
            if (argument == L"--hwnd" && index + 1 < argc)
            {
                owner = parse_window_handle(argv[++index]);
                continue;
            }
            if (argument == L"--shortcut" && index + 1 < argc)
            {
                shortcut_path = argv[++index];
                continue;
            }
            if (argument == L"--aumid" && index + 1 < argc)
            {
                aumid = argv[++index];
                continue;
            }
            if (argument == L"--legacy-install-directory" && index + 1 < argc)
            {
                legacy_install_directory = argv[++index];
                continue;
            }
            if (argument == L"--unpackaged-helper-path" && index + 1 < argc)
            {
                unpackaged_helper_path = argv[++index];
                continue;
            }
            throw hresult_invalid_argument(L"Unknown argument");
        }

        init_apartment(apartment_type::single_threaded);
        if (command == Command::PrepareLegacyTakeover)
        {
            if (legacy_install_directory.empty())
            {
                throw hresult_invalid_argument(
                    L"prepare-legacy-takeover requires --legacy-install-directory");
            }
            prepare_legacy_takeover(legacy_install_directory);
            return 0;
        }
        if (command == Command::FinalizeLegacyCleanup ||
            command == Command::FinalizeLegacyCleanupBreakawayLauncher ||
            command == Command::FinalizeLegacyCleanupUnpackaged)
        {
            if (!legacy_install_directory.empty())
            {
                throw hresult_invalid_argument(
                    L"--legacy-install-directory is only valid for prepare-legacy-takeover");
            }
            if (command == Command::FinalizeLegacyCleanup &&
                current_process_has_package_identity() &&
                !unpackaged_helper_path.empty())
            {
                run_cleanup_command(
                    current_executable_path(),
                    L"finalize-legacy-cleanup-breakaway-launcher",
                    shortcut_path,
                    aumid,
                    unpackaged_helper_path,
                    true,
                    PROCESS_CREATION_DESKTOP_APP_BREAKAWAY_ENABLE_PROCESS_TREE |
                        PROCESS_CREATION_DESKTOP_APP_BREAKAWAY_OVERRIDE);
                return 0;
            }
            if (command == Command::FinalizeLegacyCleanupBreakawayLauncher)
            {
                const std::filesystem::path helper_path =
                    validate_unpacked_cleanup_helper_path(unpackaged_helper_path);
                run_cleanup_command(
                    helper_path,
                    L"finalize-legacy-cleanup",
                    shortcut_path,
                    aumid,
                    L"",
                    false);
                return 0;
            }
            if (command == Command::FinalizeLegacyCleanupUnpackaged &&
                current_process_has_package_identity())
            {
                throw hresult_error(
                    E_ACCESSDENIED,
                    L"Refusing to mutate the real legacy registry from a packaged process");
            }
            finalize_legacy_cleanup(shortcut_path, aumid);
            return 0;
        }
        if (!shortcut_path.empty() ||
            !aumid.empty() ||
            !legacy_install_directory.empty() ||
            !unpackaged_helper_path.empty())
        {
            throw hresult_invalid_argument(L"Cleanup arguments are invalid for this command");
        }
        execute(command, owner);

        MSG message{};
        while (GetMessageW(&message, nullptr, 0, 0) > 0)
        {
            TranslateMessage(&message);
            DispatchMessageW(&message);
        }
        return static_cast<int>(message.wParam);
    }
    catch (const hresult_error& error)
    {
        std::cerr << "{\"type\":\"error\",\"hresult\":" << static_cast<int32_t>(error.code())
                  << ",\"message\":\"" << escape_json(to_string(error.message())) << "\"}\n";
        return 2;
    }
    catch (const std::exception& error)
    {
        std::cerr << "{\"type\":\"error\",\"hresult\":-1,\"message\":\""
                  << escape_json(error.what()) << "\"}\n";
        return 2;
    }
}
