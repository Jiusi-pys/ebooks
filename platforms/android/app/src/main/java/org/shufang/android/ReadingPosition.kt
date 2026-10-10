package org.shufang.android

/** Monotonic intervals carry fractional seconds across foreground transitions. */
class ForegroundReadingClock(private var active:Boolean, private val now:()->Long) {
    private var previous=now()
    private var remainder=0L
    fun elapsed(nextActive:Boolean):Long {
        val current=now()
        if(active)remainder+=(current-previous).coerceAtLeast(0)
        previous=current;active=nextActive
        val seconds=remainder/1000;remainder%=1000
        return seconds
    }
}

/** The heartbeat records the latest position and only time in the foreground. */
class ReadingPosition(var chapter: String, var ratio: Double) {
    var activeSeconds = 0L; private set
    fun move(chapter: String, ratio: Double) {
        this.chapter = chapter
        if (ratio.isFinite()) this.ratio = ratio.coerceIn(0.0, 1.0)
    }
    fun tick(seconds: Long, foreground: Boolean) {
        if (foreground) activeSeconds += seconds.coerceAtLeast(0)
    }
}
