package org.shufang.android
import org.junit.Assert.*
import org.junit.Test

class AccountRoutesTest {
    @Test fun latencyHysteresisManualSelectionAndIdentityAreStable() {
        val group=AccountRouteGroup("https://one.test","u","workspace",listOf("https://one.test","https://two.test"),null)
        assertTrue(group.accepts("u","workspace"));assertFalse(group.accepts("u","other"))
        assertEquals("one",RouteSelection.best(listOf(RouteMeasurement("one",100.0),RouteMeasurement("two",80.0)),"one",null))
        assertEquals("two",RouteSelection.best(listOf(RouteMeasurement("one",200.0),RouteMeasurement("two",100.0)),"one",null))
        assertNull(RouteSelection.best(listOf(RouteMeasurement("one",100.0)),"one","two"))
        assertEquals(group,AccountRouteGroup.decode(group.json()))
    }
}
