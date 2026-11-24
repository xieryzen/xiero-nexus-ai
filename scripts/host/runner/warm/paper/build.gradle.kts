// A plugin as small as one gets: built once when the image is made, so that
// what a Paper plugin is built with is there already (Dockerfile), and built
// again by the self-test (selftest.mjs) to see that a build works here.
plugins {
    java
}

group = "warm"
version = "1.0.0"

repositories {
    mavenCentral()
    maven("https://repo.papermc.io/repository/maven-public/")
}

dependencies {
    compileOnly("io.papermc.paper:paper-api:@PAPER@-R0.1-SNAPSHOT")
}

java {
    toolchain {
        languageVersion.set(JavaLanguageVersion.of(@JAVA@))
    }
}

tasks.processResources {
    filesMatching("plugin.yml") {
        expand("version" to project.version)
    }
}
