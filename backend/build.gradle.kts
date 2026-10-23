// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Mosaicast Authors

plugins {
    java
}

group = "dev.mosaicast.plugin"
version = "2.21.0"

java {
    toolchain {
        languageVersion.set(JavaLanguageVersion.of(21))
    }
}

repositories {
    // Dev-time alternative per ARCHITECTURE §3.5 (mavenLocal/includeBuild against an SDK checkout).
    mavenLocal()
    // The SDK's Java artifacts are on Maven Central since 0.19.2, so no GitHub Packages block and no
    // read:packages token. Versions before 0.19.2 exist only on GitHub Packages.
    mavenCentral()
}

dependencies {
    compileOnly("dev.mosaicast:plugin-api:0.20.0")
    compileOnly("org.pf4j:pf4j:3.16.0")
    annotationProcessor("org.pf4j:pf4j:3.16.0") // generates the PF4J extension index for @Extension

    testImplementation(platform("org.junit:junit-bom:6.1.3"))
    testImplementation("org.junit.jupiter:junit-jupiter")
    testImplementation("dev.mosaicast:plugin-testkit:0.20.0")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

tasks.test {
    useJUnitPlatform()
}

tasks.jar {
    archiveFileName.set("sample.jar")
}
