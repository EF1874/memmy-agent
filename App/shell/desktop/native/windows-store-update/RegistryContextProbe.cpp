#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <appmodel.h>
#include <sddl.h>
#include <shldisp.h>
#include <tlhelp32.h>

#include <algorithm>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

namespace
{
    std::wstring quote(const std::wstring& value)
    {
        std::wstring result = L"\"";
        unsigned backslashes = 0;
        for (const wchar_t character : value)
        {
            if (character == L'\\')
            {
                ++backslashes;
                continue;
            }
            if (character == L'\"')
            {
                result.append(backslashes * 2 + 1, L'\\');
                result.push_back(L'\"');
                backslashes = 0;
                continue;
            }
            result.append(backslashes, L'\\');
            backslashes = 0;
            result.push_back(character);
        }
        result.append(backslashes * 2, L'\\');
        result.push_back(L'\"');
        return result;
    }

    std::wstring executable_path()
    {
        std::vector<wchar_t> buffer(32768);
        const DWORD length = GetModuleFileNameW(nullptr, buffer.data(), static_cast<DWORD>(buffer.size()));
        if (length == 0 || length >= buffer.size())
        {
            throw std::runtime_error("GetModuleFileNameW failed");
        }
        return std::wstring(buffer.data(), length);
    }

    std::wstring registry_value(REGSAM view)
    {
        constexpr wchar_t key_path[] =
            L"Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\"
            L"886615f7-a04c-57ec-a2dd-9161dbe1a7c4";
        HKEY key = nullptr;
        const LSTATUS open_result = RegOpenKeyExW(
            HKEY_CURRENT_USER,
            key_path,
            0,
            KEY_QUERY_VALUE | view,
            &key);
        if (open_result == ERROR_FILE_NOT_FOUND || open_result == ERROR_PATH_NOT_FOUND)
        {
            return L"<missing>";
        }
        if (open_result != ERROR_SUCCESS)
        {
            return L"<open-error:" + std::to_wstring(open_result) + L">";
        }
        DWORD type = 0;
        DWORD bytes = 0;
        LSTATUS result = RegQueryValueExW(key, L"InstallLocation", nullptr, &type, nullptr, &bytes);
        if (result != ERROR_SUCCESS || (type != REG_SZ && type != REG_EXPAND_SZ))
        {
            RegCloseKey(key);
            return L"<query-error:" + std::to_wstring(result) + L">";
        }
        std::vector<wchar_t> value(bytes / sizeof(wchar_t) + 1, L'\0');
        result = RegQueryValueExW(
            key,
            L"InstallLocation",
            nullptr,
            &type,
            reinterpret_cast<BYTE*>(value.data()),
            &bytes);
        RegCloseKey(key);
        if (result != ERROR_SUCCESS)
        {
            return L"<read-error:" + std::to_wstring(result) + L">";
        }
        return value.data();
    }

    std::wstring token_user_sid(HANDLE process);

    std::wstring registry_value_hku(REGSAM view)
    {
        const std::wstring sid = token_user_sid(GetCurrentProcess());
        if (sid.empty() || sid.front() == L'<')
        {
            return sid;
        }
        const std::wstring key_path = sid +
            L"\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\"
            L"886615f7-a04c-57ec-a2dd-9161dbe1a7c4";
        HKEY key = nullptr;
        const LSTATUS open_result = RegOpenKeyExW(
            HKEY_USERS,
            key_path.c_str(),
            0,
            KEY_QUERY_VALUE | view,
            &key);
        if (open_result == ERROR_FILE_NOT_FOUND || open_result == ERROR_PATH_NOT_FOUND)
        {
            return L"<missing>";
        }
        if (open_result != ERROR_SUCCESS)
        {
            return L"<open-error:" + std::to_wstring(open_result) + L">";
        }
        DWORD type = 0;
        DWORD bytes = 0;
        LSTATUS result = RegQueryValueExW(key, L"InstallLocation", nullptr, &type, nullptr, &bytes);
        if (result != ERROR_SUCCESS || (type != REG_SZ && type != REG_EXPAND_SZ))
        {
            RegCloseKey(key);
            return L"<query-error:" + std::to_wstring(result) + L">";
        }
        std::vector<wchar_t> value(bytes / sizeof(wchar_t) + 1, L'\0');
        result = RegQueryValueExW(
            key,
            L"InstallLocation",
            nullptr,
            &type,
            reinterpret_cast<BYTE*>(value.data()),
            &bytes);
        RegCloseKey(key);
        if (result != ERROR_SUCCESS)
        {
            return L"<read-error:" + std::to_wstring(result) + L">";
        }
        return value.data();
    }

    std::wstring token_user_sid(HANDLE process)
    {
        HANDLE token = nullptr;
        if (!OpenProcessToken(process, TOKEN_QUERY, &token))
        {
            return L"<token-error:" + std::to_wstring(GetLastError()) + L">";
        }
        DWORD bytes = 0;
        GetTokenInformation(token, TokenUser, nullptr, 0, &bytes);
        std::vector<unsigned char> storage(bytes);
        if (!GetTokenInformation(token, TokenUser, storage.data(), bytes, &bytes))
        {
            const DWORD error = GetLastError();
            CloseHandle(token);
            return L"<user-error:" + std::to_wstring(error) + L">";
        }
        LPWSTR sid_text = nullptr;
        const auto* user = reinterpret_cast<TOKEN_USER*>(storage.data());
        if (!ConvertSidToStringSidW(user->User.Sid, &sid_text))
        {
            const DWORD error = GetLastError();
            CloseHandle(token);
            return L"<sid-error:" + std::to_wstring(error) + L">";
        }
        std::wstring result(sid_text);
        LocalFree(sid_text);
        CloseHandle(token);
        return result;
    }

    void write_observation(const std::filesystem::path& output)
    {
        UINT32 package_length = 0;
        const LONG package_result = GetCurrentPackageFullName(&package_length, nullptr);
        DWORD session_id = 0;
        ProcessIdToSessionId(GetCurrentProcessId(), &session_id);
        std::wofstream stream(output, std::ios::binary | std::ios::trunc);
        stream << L"pid=" << GetCurrentProcessId() << L"\n";
        stream << L"session=" << session_id << L"\n";
        stream << L"packageResult=" << package_result << L"\n";
        stream << L"sid=" << token_user_sid(GetCurrentProcess()) << L"\n";
        stream << L"view32=" << registry_value(KEY_WOW64_32KEY) << L"\n";
        stream << L"view64=" << registry_value(KEY_WOW64_64KEY) << L"\n";
        stream << L"hku32=" << registry_value_hku(KEY_WOW64_32KEY) << L"\n";
        stream << L"hku64=" << registry_value_hku(KEY_WOW64_64KEY) << L"\n";
    }

    HANDLE find_explorer_process()
    {
        DWORD current_session = 0;
        ProcessIdToSessionId(GetCurrentProcessId(), &current_session);
        const std::wstring current_sid = token_user_sid(GetCurrentProcess());
        HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if (snapshot == INVALID_HANDLE_VALUE)
        {
            return nullptr;
        }
        PROCESSENTRY32W entry{};
        entry.dwSize = sizeof(entry);
        HANDLE result = nullptr;
        if (Process32FirstW(snapshot, &entry))
        {
            do
            {
                if (_wcsicmp(entry.szExeFile, L"explorer.exe") != 0)
                {
                    continue;
                }
                DWORD session = 0;
                if (!ProcessIdToSessionId(entry.th32ProcessID, &session) || session != current_session)
                {
                    continue;
                }
                HANDLE candidate = OpenProcess(
                    PROCESS_CREATE_PROCESS | PROCESS_QUERY_LIMITED_INFORMATION,
                    FALSE,
                    entry.th32ProcessID);
                if (candidate != nullptr && token_user_sid(candidate) == current_sid)
                {
                    result = candidate;
                    break;
                }
                if (candidate != nullptr)
                {
                    CloseHandle(candidate);
                }
            }
            while (Process32NextW(snapshot, &entry));
        }
        CloseHandle(snapshot);
        return result;
    }

    int wait_for_child(PROCESS_INFORMATION& process)
    {
        CloseHandle(process.hThread);
        const DWORD wait_result = WaitForSingleObject(process.hProcess, 30000);
        DWORD exit_code = 0xffffffff;
        if (wait_result == WAIT_OBJECT_0)
        {
            GetExitCodeProcess(process.hProcess, &exit_code);
        }
        CloseHandle(process.hProcess);
        return wait_result == WAIT_OBJECT_0 ? static_cast<int>(exit_code) : 120;
    }

    int spawn_with_explorer_parent(const std::filesystem::path& output)
    {
        HANDLE explorer = find_explorer_process();
        if (explorer == nullptr)
        {
            return 101;
        }
        SIZE_T bytes = 0;
        InitializeProcThreadAttributeList(nullptr, 1, 0, &bytes);
        std::vector<unsigned char> storage(bytes);
        STARTUPINFOEXW startup{};
        startup.StartupInfo.cb = sizeof(startup);
        startup.lpAttributeList = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(storage.data());
        if (!InitializeProcThreadAttributeList(startup.lpAttributeList, 1, 0, &bytes))
        {
            CloseHandle(explorer);
            return 102;
        }
        if (!UpdateProcThreadAttribute(
                startup.lpAttributeList,
                0,
                PROC_THREAD_ATTRIBUTE_PARENT_PROCESS,
                &explorer,
                sizeof(explorer),
                nullptr,
                nullptr))
        {
            DeleteProcThreadAttributeList(startup.lpAttributeList);
            CloseHandle(explorer);
            return 103;
        }
        const std::wstring executable = executable_path();
        std::wstring command_line = quote(executable) + L" child " + quote(output.wstring());
        PROCESS_INFORMATION process{};
        const BOOL created = CreateProcessW(
            executable.c_str(),
            command_line.data(),
            nullptr,
            nullptr,
            FALSE,
            CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT,
            nullptr,
            std::filesystem::path(executable).parent_path().c_str(),
            &startup.StartupInfo,
            &process);
        DeleteProcThreadAttributeList(startup.lpAttributeList);
        CloseHandle(explorer);
        if (!created)
        {
            return static_cast<int>(GetLastError());
        }
        return wait_for_child(process);
    }

    int spawn_with_explorer_token(const std::filesystem::path& output)
    {
        HANDLE explorer = find_explorer_process();
        if (explorer == nullptr)
        {
            return 111;
        }
        HANDLE token = nullptr;
        if (!OpenProcessToken(
                explorer,
                TOKEN_QUERY | TOKEN_DUPLICATE | TOKEN_ASSIGN_PRIMARY,
                &token))
        {
            CloseHandle(explorer);
            return static_cast<int>(GetLastError());
        }
        HANDLE primary = nullptr;
        const BOOL duplicated = DuplicateTokenEx(
            token,
            TOKEN_QUERY | TOKEN_DUPLICATE | TOKEN_ASSIGN_PRIMARY,
            nullptr,
            SecurityImpersonation,
            TokenPrimary,
            &primary);
        CloseHandle(token);
        CloseHandle(explorer);
        if (!duplicated)
        {
            return static_cast<int>(GetLastError());
        }
        const std::wstring executable = executable_path();
        std::wstring command_line = quote(executable) + L" child " + quote(output.wstring());
        STARTUPINFOW startup{};
        startup.cb = sizeof(startup);
        PROCESS_INFORMATION process{};
        const BOOL created = CreateProcessWithTokenW(
            primary,
            0,
            executable.c_str(),
            command_line.data(),
            CREATE_NO_WINDOW,
            nullptr,
            std::filesystem::path(executable).parent_path().c_str(),
            &startup,
            &process);
        const DWORD create_error = created ? ERROR_SUCCESS : GetLastError();
        CloseHandle(primary);
        if (!created)
        {
            return static_cast<int>(create_error);
        }
        return wait_for_child(process);
    }

    int spawn_relay_child(const std::filesystem::path& output)
    {
        write_observation(output.wstring() + L".relay.txt");
        const std::wstring executable = executable_path();
        std::wstring command_line = quote(executable) + L" child " + quote(output.wstring());
        STARTUPINFOW startup{};
        startup.cb = sizeof(startup);
        PROCESS_INFORMATION process{};
        if (!CreateProcessW(
                executable.c_str(),
                command_line.data(),
                nullptr,
                nullptr,
                FALSE,
                CREATE_NO_WINDOW,
                nullptr,
                std::filesystem::path(executable).parent_path().c_str(),
                &startup,
                &process))
        {
            return static_cast<int>(GetLastError());
        }
        return wait_for_child(process);
    }

    int spawn_with_explorer_parent_relay(const std::filesystem::path& output)
    {
        HANDLE explorer = find_explorer_process();
        if (explorer == nullptr)
        {
            return 121;
        }
        SIZE_T bytes = 0;
        InitializeProcThreadAttributeList(nullptr, 2, 0, &bytes);
        std::vector<unsigned char> storage(bytes);
        STARTUPINFOEXW startup{};
        startup.StartupInfo.cb = sizeof(startup);
        startup.lpAttributeList = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(storage.data());
        if (!InitializeProcThreadAttributeList(startup.lpAttributeList, 2, 0, &bytes))
        {
            CloseHandle(explorer);
            return 122;
        }
        if (!UpdateProcThreadAttribute(
                startup.lpAttributeList,
                0,
                PROC_THREAD_ATTRIBUTE_PARENT_PROCESS,
                &explorer,
                sizeof(explorer),
                nullptr,
                nullptr))
        {
            DeleteProcThreadAttributeList(startup.lpAttributeList);
            CloseHandle(explorer);
            return 123;
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
            DeleteProcThreadAttributeList(startup.lpAttributeList);
            CloseHandle(explorer);
            return 124;
        }
        const std::wstring executable = executable_path();
        std::wstring command_line = quote(executable) + L" relay " + quote(output.wstring());
        PROCESS_INFORMATION process{};
        const BOOL created = CreateProcessW(
            executable.c_str(),
            command_line.data(),
            nullptr,
            nullptr,
            FALSE,
            CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT,
            nullptr,
            std::filesystem::path(executable).parent_path().c_str(),
            &startup.StartupInfo,
            &process);
        const DWORD create_error = created ? ERROR_SUCCESS : GetLastError();
        DeleteProcThreadAttributeList(startup.lpAttributeList);
        CloseHandle(explorer);
        if (!created)
        {
            return static_cast<int>(create_error);
        }
        return wait_for_child(process);
    }

    void write_launcher_result(const std::filesystem::path& output, int result)
    {
        std::wofstream stream(output.wstring() + L".launcher.txt", std::ios::binary | std::ios::trunc);
        stream << L"result=" << result << L"\n";
    }

    int spawn_with_shell_automation(const std::filesystem::path& output)
    {
        const HRESULT initialize_result = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
        if (FAILED(initialize_result) && initialize_result != RPC_E_CHANGED_MODE)
        {
            return static_cast<int>(initialize_result);
        }
        IShellDispatch2* shell = nullptr;
        const HRESULT create_result = CoCreateInstance(
            CLSID_Shell,
            nullptr,
            CLSCTX_INPROC_SERVER | CLSCTX_LOCAL_SERVER,
            IID_PPV_ARGS(&shell));
        if (FAILED(create_result))
        {
            if (SUCCEEDED(initialize_result))
            {
                CoUninitialize();
            }
            return static_cast<int>(create_result);
        }
        const std::wstring executable = executable_path();
        const std::wstring argument_text = L"child " + quote(output.wstring());
        VARIANT arguments{};
        VARIANT directory{};
        VARIANT operation{};
        VARIANT show{};
        VariantInit(&arguments);
        VariantInit(&directory);
        VariantInit(&operation);
        VariantInit(&show);
        arguments.vt = VT_BSTR;
        arguments.bstrVal = SysAllocString(argument_text.c_str());
        directory.vt = VT_BSTR;
        directory.bstrVal = SysAllocString(std::filesystem::path(executable).parent_path().c_str());
        operation.vt = VT_BSTR;
        operation.bstrVal = SysAllocString(L"open");
        show.vt = VT_I4;
        show.lVal = SW_HIDE;
        BSTR file = SysAllocString(executable.c_str());
        const HRESULT execute_result = shell->ShellExecute(
            file,
            arguments,
            directory,
            operation,
            show);
        SysFreeString(file);
        VariantClear(&arguments);
        VariantClear(&directory);
        VariantClear(&operation);
        VariantClear(&show);
        shell->Release();
        if (SUCCEEDED(initialize_result))
        {
            CoUninitialize();
        }
        if (FAILED(execute_result))
        {
            return static_cast<int>(execute_result);
        }
        for (int attempt = 0; attempt < 100; ++attempt)
        {
            std::error_code error;
            if (std::filesystem::is_regular_file(output, error) && !error)
            {
                return 0;
            }
            Sleep(50);
        }
        return 1460;
    }

    int run_process_and_wait(
        const std::filesystem::path& executable,
        const std::vector<std::wstring>& arguments)
    {
        std::wstring command_line = quote(executable.wstring());
        for (const auto& argument : arguments)
        {
            command_line.push_back(L' ');
            command_line.append(quote(argument));
        }
        STARTUPINFOW startup{};
        startup.cb = sizeof(startup);
        PROCESS_INFORMATION process{};
        if (!CreateProcessW(
                executable.c_str(),
                command_line.data(),
                nullptr,
                nullptr,
                FALSE,
                CREATE_NO_WINDOW,
                nullptr,
                executable.parent_path().c_str(),
                &startup,
                &process))
        {
            return static_cast<int>(GetLastError());
        }
        return wait_for_child(process);
    }

    std::wstring current_sam_user_name()
    {
        wchar_t domain[256]{};
        wchar_t user[256]{};
        const DWORD domain_length = GetEnvironmentVariableW(L"USERDOMAIN", domain, 256);
        const DWORD user_length = GetEnvironmentVariableW(L"USERNAME", user, 256);
        if (domain_length == 0 || domain_length >= 256 || user_length == 0 || user_length >= 256)
        {
            return {};
        }
        return std::wstring(domain) + L"\\" + user;
    }

    int spawn_with_scheduled_task(const std::filesystem::path& output)
    {
        wchar_t windows_directory[MAX_PATH]{};
        const UINT windows_length = GetWindowsDirectoryW(windows_directory, MAX_PATH);
        if (windows_length == 0 || windows_length >= MAX_PATH)
        {
            return static_cast<int>(GetLastError());
        }
        const std::filesystem::path schtasks =
            std::filesystem::path(windows_directory) / L"System32" / L"schtasks.exe";
        const std::wstring user_name = current_sam_user_name();
        if (user_name.empty())
        {
            return 1317;
        }
        const std::wstring task_name =
            L"Codex-Memmy-RegistryBrokerProbe-" + std::to_wstring(GetCurrentProcessId());
        const std::wstring action =
            quote(executable_path()) + L" child " + quote(output.wstring());
        const int create_result = run_process_and_wait(schtasks, {
            L"/Create",
            L"/TN", task_name,
            L"/SC", L"ONCE",
            L"/ST", L"23:59",
            L"/TR", action,
            L"/RU", user_name,
            L"/RL", L"LIMITED",
            L"/IT",
            L"/F"
        });
        int run_result = -1;
        int probe_result = -1;
        if (create_result == 0)
        {
            run_result = run_process_and_wait(schtasks, {
                L"/Run",
                L"/TN", task_name
            });
            if (run_result == 0)
            {
                for (int attempt = 0; attempt < 200; ++attempt)
                {
                    std::error_code error;
                    if (std::filesystem::is_regular_file(output, error) && !error)
                    {
                        probe_result = 0;
                        break;
                    }
                    Sleep(50);
                }
                if (probe_result != 0)
                {
                    probe_result = 1460;
                }
            }
        }
        const int delete_result = run_process_and_wait(schtasks, {
            L"/Delete",
            L"/TN", task_name,
            L"/F"
        });
        std::wofstream status(output.wstring() + L".task.txt", std::ios::binary | std::ios::trunc);
        status << L"taskName=" << task_name << L"\n";
        status << L"user=" << user_name << L"\n";
        status << L"createResult=" << create_result << L"\n";
        status << L"runResult=" << run_result << L"\n";
        status << L"probeResult=" << probe_result << L"\n";
        status << L"deleteResult=" << delete_result << L"\n";
        if (create_result != 0)
        {
            return create_result;
        }
        if (run_result != 0)
        {
            return run_result;
        }
        if (probe_result != 0)
        {
            return probe_result;
        }
        return delete_result;
    }
}

int wmain(int argc, wchar_t* argv[])
{
    if (argc != 3)
    {
        return 64;
    }
    const std::wstring mode = argv[1];
    const std::filesystem::path output = argv[2];
    if (mode == L"child")
    {
        write_observation(output);
        return 0;
    }
    if (mode == L"parent")
    {
        const int result = spawn_with_explorer_parent(output);
        write_launcher_result(output, result);
        return result;
    }
    if (mode == L"token")
    {
        const int result = spawn_with_explorer_token(output);
        write_launcher_result(output, result);
        return result;
    }
    if (mode == L"relay")
    {
        const int result = spawn_relay_child(output);
        write_launcher_result(output, result);
        return result;
    }
    if (mode == L"parent-relay")
    {
        const int result = spawn_with_explorer_parent_relay(output);
        write_launcher_result(output, result);
        return result;
    }
    if (mode == L"shell")
    {
        const int result = spawn_with_shell_automation(output);
        write_launcher_result(output, result);
        return result;
    }
    if (mode == L"task")
    {
        const int result = spawn_with_scheduled_task(output);
        write_launcher_result(output, result);
        return result;
    }
    return 65;
}
