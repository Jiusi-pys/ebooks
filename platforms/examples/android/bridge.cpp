#include <jni.h>
#include <cstring>
#include <limits>
#include "../../../base/crates/bindings/include/shufang.h"

extern "C" JNIEXPORT jbyteArray JNICALL
Java_shufang_core_NativeCore_executeBytes(JNIEnv* env, jobject, jbyteArray request) {
    const auto length = env->GetArrayLength(request);
    const auto input = core_alloc(static_cast<size_t>(length));
    if (!input || core_abi_version() != 1) {
        if (input) core_free(input);
        env->ThrowNew(env->FindClass("java/lang/IllegalStateException"), "core allocation or ABI failure");
        return nullptr;
    }
    env->GetByteArrayRegion(request, 0, length, reinterpret_cast<jbyte*>(input));
    if (env->ExceptionCheck()) { core_free(input); return nullptr; }
    const auto output = core_execute(input);
    core_free(input);
    const auto size = core_buffer_len(output);
    if (!output || size > static_cast<size_t>(std::numeric_limits<jsize>::max())) {
        if (output) core_free(output);
        env->ThrowNew(env->FindClass("java/lang/IllegalStateException"), "core execution failure");
        return nullptr;
    }
    auto result = env->NewByteArray(static_cast<jsize>(size));
    if (result) env->SetByteArrayRegion(result, 0, static_cast<jsize>(size), reinterpret_cast<const jbyte*>(output));
    core_free(output);
    return result;
}
