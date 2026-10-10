package shufang.core

object NativeCore {
    init { System.loadLibrary("shufang_jni") }
    private external fun executeBytes(request: ByteArray): ByteArray
    fun execute(request: String): String {
        val encoder=Charsets.UTF_8.newEncoder()
            .onMalformedInput(java.nio.charset.CodingErrorAction.REPORT)
        val bytes=try {encoder.encode(java.nio.CharBuffer.wrap(request))}catch(error:java.nio.charset.CharacterCodingException){throw IllegalArgumentException("invalid_utf16",error)}
        val input=ByteArray(bytes.remaining());bytes.get(input)
        return Charsets.UTF_8.newDecoder().onMalformedInput(java.nio.charset.CodingErrorAction.REPORT)
            .decode(java.nio.ByteBuffer.wrap(executeBytes(input))).toString()
    }
}
