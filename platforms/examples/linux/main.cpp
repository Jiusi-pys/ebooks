#include "../../../base/crates/bindings/include/shufang.h"
#include <cstring>
#include <iostream>
#include <stdexcept>
#include <string>

// Qt/GTK ViewModels can call the same adapter on a worker thread.
std::string execute(const std::string& request) {
    if (core_abi_version() != 1) throw std::runtime_error("ABI mismatch");
    const auto input = core_alloc(request.size());
    if (!input) throw std::runtime_error("allocation failed");
    std::memcpy(reinterpret_cast<void*>(input), request.data(), request.size());
    const auto output = core_execute(input);
    core_free(input);
    if (!output) throw std::runtime_error("execution failed");
    try {
        std::string result(reinterpret_cast<const char*>(output), core_buffer_len(output));
        core_free(output);
        return result;
    } catch (...) {
        core_free(output);
        throw;
    }
}
int main() {
    const auto result = execute(R"({"version":1,"command":"nextClock","previous":"9007199254740993:1","now":1})");
    std::cout << result << '\n';
    return result.find("9007199254740993:2") == std::string::npos ? 1 : 0;
}
