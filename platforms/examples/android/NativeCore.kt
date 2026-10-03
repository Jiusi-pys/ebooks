package shufang.core

/** Compose/ViewModel code calls this adapter from an IO coroutine. */
object NativeCore {
    init { System.loadLibrary("shufang_jni") }
    private external fun executeBytes(request: ByteArray): ByteArray
    fun execute(request: String): String =
        executeBytes(request.toByteArray(Charsets.UTF_8)).toString(Charsets.UTF_8)
}
