package org.shufang.android

import org.junit.Assert.*
import org.junit.Test

class AiContextTest {
    @Test fun chunksKeepEveryCharacterAndNeverSplitUtf16Pairs() {
        val text="x".repeat(23999)+"🚀"+"y".repeat(48000)+"🌱"
        val parts=AiContext.chunks(text,24000)
        assertEquals(text,parts.joinToString(""))
        assertTrue(parts.all {it.length<=24000 && !it.last().isHighSurrogate() && !it.first().isLowSurrogate()})
        assertEquals("x".repeat(23999),AiContext.prefix(text,24000))
    }
    @Test fun emptyAndExactBoundaryRemainStable() {
        assertTrue(AiContext.chunks("",24000).isEmpty())
        assertEquals(listOf("中文"),AiContext.chunks("中文",2))
        assertEquals("🚀",AiContext.prefix("🚀中文",2))
    }
}
