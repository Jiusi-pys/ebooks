package org.shufang.android
import org.junit.Assert.*
import org.junit.Test
import org.json.JSONObject

class PortableInkTest {
    @Test fun preservesStrokeIdentityAndPressureAcrossBothRepresentations() {
        val ink=PortableInk(1000.0,1400.0,listOf(InkStroke("stroke-a","pen",listOf(0.1,0.2,0.3,1.0),3.0,listOf(InkPoint(30.0,40.0,.7,.3,.2,0.0),InkPoint(50.0,70.0,.9,.4,.3,.05)))))
        assertEquals(ink,PortableInk.decode(ink.json()))
        val history=InkHistory(ink);history.append(ink.strokes[0].copy(id="stroke-b"));assertEquals(2,history.value.strokes.size)
        history.undo();assertEquals(ink,history.value);history.redo();assertEquals(2,history.value.strokes.size)
        history.erase("stroke-a");assertEquals("stroke-b",history.value.strokes.single().id);history.undo();assertEquals(2,history.value.strokes.size)
    }
    @Test fun refusesUnknownVersionsAndMalformedCoordinates() {
        val ink=PortableInk(1000.0,1400.0,emptyList()).json();ink.put("version",2)
        assertThrows(IllegalArgumentException::class.java){PortableInk.decode(ink)}
        assertThrows(IllegalArgumentException::class.java){PortableInk(1000.0,-1.0,emptyList()).json()}
        val point=InkPoint(Double.NaN,0.0,1.0,0.0,0.0,0.0)
        assertThrows(IllegalArgumentException::class.java){PortableInk(1000.0,1000.0,listOf(InkStroke("a","pen",listOf(0.0,0.0,0.0,1.0),2.0,listOf(point)))).json()}
    }
}
