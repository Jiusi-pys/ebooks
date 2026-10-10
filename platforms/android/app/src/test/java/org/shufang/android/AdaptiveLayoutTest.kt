package org.shufang.android

import org.junit.Assert.*
import org.junit.Test

class AdaptiveLayoutTest {
    @Test fun windowAndFontScaleLeaveUsableReadingSpace() {
        for(width in listOf(320f,360f,412f,600f,720f,840f,1024f)) for(scale in listOf(1f,1.3f,2f)) {
            val layout=AdaptiveLayout.calculate(width,600f,scale)
            assertEquals(width>=600f,layout.rail)
            assertTrue(layout.coverColumns>=1)
            assertTrue(layout.panelWidth<=width-32f)
            assertTrue(layout.contentWidth>0)
            assertEquals(width*.92f,layout.readingWidth(92f),.01f)
        }
        assertFalse(AdaptiveLayout.calculate(840f,300f,2f).sideBySide)
        assertTrue(AdaptiveLayout.calculate(1024f,768f,1f).sideBySide)
    }
    @Test fun narrowPanelsAndInvalidMeasurementsAreBounded() {
        assertEquals(288f,AdaptiveLayout.calculate(320f,400f,1f).panelWidth,.01f)
        assertEquals(160f,AdaptiveLayout.calculate(320f,400f,1f).readingWidth(0f),.01f)
        assertEquals(320f,AdaptiveLayout.calculate(320f,400f,1f).readingWidth(200f),.01f)
    }
}
