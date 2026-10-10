package org.shufang.android

import org.junit.Assert.*
import org.junit.Test

class ReadingPositionTest {
    @Test fun partialForegroundIntervalsSurvivePauseWithoutCountingBackground() {
        var now=0L
        val clock=ForegroundReadingClock(true) {now}
        now=14_750;assertEquals(14L,clock.elapsed(false))
        now=44_750;assertEquals(0L,clock.elapsed(true))
        now=52_000;assertEquals(8L,clock.elapsed(false))
        now=60_000;assertEquals(0L,clock.elapsed(false))
    }
    @Test fun heartbeatUsesLatestChapterAndDoesNotCountBackgroundTime() {
        val position = ReadingPosition("one", 0.2)
        position.move("two", 0.8)
        position.tick(15, true)
        position.tick(60, false)
        assertEquals("two", position.chapter)
        assertEquals(0.8, position.ratio, 0.0)
        assertEquals(15L, position.activeSeconds)
    }
    @Test fun progressIsBoundedAndNonFiniteInputCannotCorruptData() {
        val position = ReadingPosition("one", 0.0)
        position.move("two", 2.0)
        assertEquals(1.0, position.ratio, 0.0)
        position.move("two", Double.NaN)
        assertEquals(1.0, position.ratio, 0.0)
    }
}
